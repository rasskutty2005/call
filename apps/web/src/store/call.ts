'use client';

import { create } from 'zustand';
import type {
  ActiveCall,
  CallEndReason,
  CallPeer,
  CallQuality,
  CallState,
  IceConfigResponse,
  RTCIceCandidateLike,
  VoiceMetrics,
  VoicePresetId,
} from '@sonder/shared';
import {
  DEFAULT_INTENSITY,
  DEFAULT_VOICE_PRESET,
} from '@sonder/shared';
import { api } from '@/lib/api';
import { emitWithAck, getSocket, SocketError } from '@/lib/socket';
import { CallSession, type CallRole } from '@/features/calling/CallSession';
import type { VoiceOverrides } from '@/voice/VoiceConverter';

/**
 * Legal transitions. Every state change goes through `transition()`, so an
 * out-of-order signalling event (a late `call:accepted` after the user already
 * hung up, say) cannot drive the UI into an impossible state such as CONNECTED
 * after ENDED.
 */
const ALLOWED_TRANSITIONS: Record<CallState, CallState[]> = {
  IDLE: ['CALLING', 'RINGING'],
  CALLING: ['RINGING', 'ACCEPTED', 'CONNECTING', 'ENDED'],
  RINGING: ['ACCEPTED', 'CONNECTING', 'ENDED'],
  ACCEPTED: ['CONNECTING', 'CONNECTED', 'ENDED'],
  CONNECTING: ['CONNECTED', 'RECONNECTING', 'ENDED'],
  CONNECTED: ['RECONNECTING', 'ENDED'],
  RECONNECTING: ['CONNECTED', 'ENDED'],
  ENDED: ['IDLE'],
};

export interface CallError {
  code: string;
  message: string;
}

interface CallStoreState {
  state: CallState;
  callId: string | null;
  peer: CallPeer | null;
  role: CallRole | null;
  conversationId: string | null;

  /** Seconds since the call connected. Driven by a 1 s ticker, not by guessing. */
  durationSec: number;
  connectedAt: number | null;

  muted: boolean;
  voiceChangerEnabled: boolean;
  preset: VoicePresetId;
  intensity: number;
  overrides: VoiceOverrides;
  voiceMetrics: VoiceMetrics | null;
  outputLevel: number;

  quality: CallQuality | null;
  hasTurn: boolean;
  /** Remote audio needs a user gesture before it can play. */
  audioBlocked: boolean;

  error: CallError | null;
  /** Populated when a call finishes, for the "call ended" summary. */
  lastEndReason: CallEndReason | null;

  /* actions */
  startCall(peer: CallPeer, options?: { conversationId?: string }): Promise<void>;
  acceptCall(): Promise<void>;
  rejectCall(): Promise<void>;
  endCall(reason?: CallEndReason): Promise<void>;
  dismissError(): void;
  resumeAudio(): Promise<void>;

  toggleMute(): void;
  setVoiceChangerEnabled(enabled: boolean): void;
  setPreset(preset: VoicePresetId): void;
  setIntensity(value: number): void;
  setOverrides(overrides: VoiceOverrides): void;
  resetOverrides(): void;

  /* socket ingress — called by the CallBridge */
  handleIncoming(call: ActiveCall): void;
  handleRinging(): void;
  handleAccepted(): Promise<void>;
  handleRejected(reason: 'REJECTED' | 'BUSY'): void;
  handleEnded(payload: { callId: string; reason: CallEndReason; durationSec: number }): void;
  handleFailed(payload: { code: string; message: string }): void;
  handleReconnecting(): void;
  handleRemoteOffer(payload: { callId: string; description: RTCSessionDescriptionInit }): Promise<void>;
  handleRemoteAnswer(payload: { callId: string; description: RTCSessionDescriptionInit }): Promise<void>;
  handleRemoteCandidate(payload: { callId: string; candidate: RTCIceCandidateLike }): Promise<void>;
}

/* Non-reactive singletons: these must not trigger React re-renders. */
let session: CallSession | null = null;
let durationTimer: ReturnType<typeof setInterval> | null = null;
let levelTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Signalling that arrived before the RTCPeerConnection existed. The callee can
 * legitimately receive the caller's offer in the same tick it accepts, before
 * `connect()` has finished.
 */
const pendingSignals: {
  offers: RTCSessionDescriptionInit[];
  answers: RTCSessionDescriptionInit[];
  candidates: RTCIceCandidateLike[];
} = { offers: [], answers: [], candidates: [] };

function clearPendingSignals() {
  pendingSignals.offers = [];
  pendingSignals.answers = [];
  pendingSignals.candidates = [];
}

export const useCallStore = create<CallStoreState>((set, get) => {
  function transition(next: CallState): boolean {
    const current = get().state;
    if (current === next) return true;
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      // Not an error worth showing a user — it means a stale event arrived.
      console.warn(`[call] ignored illegal transition ${current} -> ${next}`);
      return false;
    }
    set({ state: next });
    return true;
  }

  function startTickers() {
    stopTickers();
    durationTimer = setInterval(() => {
      const { connectedAt } = get();
      if (connectedAt) {
        set({ durationSec: Math.floor((Date.now() - connectedAt) / 1000) });
      }
    }, 1000);
    levelTimer = setInterval(() => {
      if (session) set({ outputLevel: session.audioPipeline.getOutputLevel() });
    }, 120);
  }

  function stopTickers() {
    if (durationTimer) clearInterval(durationTimer);
    if (levelTimer) clearInterval(levelTimer);
    durationTimer = null;
    levelTimer = null;
  }

  async function teardown() {
    stopTickers();
    clearPendingSignals();
    const current = session;
    session = null;
    await current?.close();
  }

  function resetToIdle(reason: CallEndReason | null) {
    set({
      state: 'IDLE',
      callId: null,
      peer: null,
      role: null,
      conversationId: null,
      durationSec: 0,
      connectedAt: null,
      muted: false,
      voiceChangerEnabled: false,
      voiceMetrics: null,
      outputLevel: 0,
      quality: null,
      audioBlocked: false,
      lastEndReason: reason,
    });
  }

  /** Builds a CallSession and wires its callbacks to signalling. */
  function createSession(callId: string, role: CallRole): CallSession {
    return new CallSession(
      { callId, role },
      {
        sendOffer(description) {
          void emitWithAck('webrtc:offer', { callId, description }).catch(
            (error: SocketError) => {
              set({ error: { code: error.code, message: error.message } });
            },
          );
        },
        sendAnswer(description) {
          void emitWithAck('webrtc:answer', { callId, description }).catch(() => undefined);
        },
        sendIceCandidate(candidate) {
          getSocket().emit('webrtc:ice-candidate', { callId, candidate });
        },
        onConnected() {
          // Reported only because the RTCPeerConnection said so.
          const alreadyConnected = get().connectedAt !== null;
          if (!transition('CONNECTED')) return;
          if (!alreadyConnected) {
            set({ connectedAt: Date.now(), durationSec: 0 });
            startTickers();
          }
          const voice = session?.getVoiceState() ?? { enabled: false, preset: null };
          void emitWithAck('call:connected', {
            callId,
            voiceChangerEnabled: voice.enabled,
            voicePreset: voice.preset,
          }).catch(() => undefined);
        },
        onReconnecting() {
          if (transition('RECONNECTING')) {
            getSocket().emit('call:reconnecting', { callId });
          }
        },
        onFailed(reason) {
          set({ error: { code: 'WEBRTC_FAILED', message: reason } });
          void get().endCall('FAILED');
        },
        onQuality(quality) {
          set({ quality });
        },
        onError(error) {
          set({ error: { code: 'AUDIO', message: error.message } });
        },
        onAudioBlocked() {
          set({ audioBlocked: true });
        },
      },
    );
  }

  /** Applies whatever signalling queued up while the session was being built. */
  async function flushPendingSignals() {
    if (!session) return;
    const offers = pendingSignals.offers.splice(0);
    const answers = pendingSignals.answers.splice(0);
    const candidates = pendingSignals.candidates.splice(0);

    for (const description of offers) await session.handleRemoteDescription(description);
    for (const description of answers) await session.handleRemoteDescription(description);
    for (const candidate of candidates) await session.handleRemoteCandidate(candidate);
  }

  async function fetchIceConfig(): Promise<IceConfigResponse> {
    const config = await api.get<IceConfigResponse>('/api/calls/ice-config');
    set({ hasTurn: config.hasTurn });
    return config;
  }

  /** Applies the current voice settings to a freshly built pipeline. */
  function applyVoiceSettings() {
    if (!session) return;
    const { preset, intensity, overrides, voiceChangerEnabled, muted } = get();
    const pipeline = session.audioPipeline;
    pipeline.setPreset(preset);
    pipeline.setIntensity(intensity);
    if (Object.keys(overrides).length > 0) pipeline.setOverrides(overrides);
    pipeline.setVoiceChangerEnabled(voiceChangerEnabled);
    pipeline.setMuted(muted);
  }

  return {
    state: 'IDLE',
    callId: null,
    peer: null,
    role: null,
    conversationId: null,
    durationSec: 0,
    connectedAt: null,
    muted: false,
    voiceChangerEnabled: false,
    preset: DEFAULT_VOICE_PRESET,
    intensity: DEFAULT_INTENSITY,
    overrides: {},
    voiceMetrics: null,
    outputLevel: 0,
    quality: null,
    hasTurn: false,
    audioBlocked: false,
    error: null,
    lastEndReason: null,

    async startCall(peer, options = {}) {
      if (get().state !== 'IDLE') {
        set({ error: { code: 'ALREADY_IN_CALL', message: 'You are already on a call.' } });
        return;
      }

      set({
        peer,
        role: 'caller',
        conversationId: options.conversationId ?? null,
        error: null,
        lastEndReason: null,
        quality: null,
      });
      transition('CALLING');

      // Microphone permission is resolved BEFORE anyone's phone rings: it is far
      // better to fail here than to ring someone and then drop the call.
      let temporary: CallSession | null = null;
      try {
        temporary = createSession('pending', 'caller');
        await temporary.prepareAudio();
      } catch (error) {
        await temporary?.close();
        resetToIdle(null);
        set({
          error: {
            code: 'MIC',
            message:
              error instanceof Error
                ? error.message
                : 'The microphone could not be opened.',
          },
        });
        return;
      }

      try {
        const call = await emitWithAck<ActiveCall>('call:start', {
          calleeId: peer.id,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        });

        // Rebuild the session with the real call id, reusing nothing: the
        // pipeline is cheap to recreate and this keeps ids honest.
        await temporary.close();
        session = createSession(call.id, 'caller');
        await session.prepareAudio();
        applyVoiceSettings();
        session.audioPipeline.setVoiceChangerEnabled(get().voiceChangerEnabled);

        set({ callId: call.id, peer: call.peer, conversationId: call.conversationId });
        startTickers();
      } catch (error) {
        await temporary?.close();
        await teardown();
        const socketError = error as SocketError;
        resetToIdle(null);
        set({
          error: {
            code: socketError.code ?? 'CALL_FAILED',
            message: socketError.message ?? 'The call could not be placed.',
          },
        });
      }
    },

    handleIncoming(call) {
      // Already busy locally: the server also guards this, but a second incoming
      // call must never replace the one in progress.
      if (get().state !== 'IDLE') return;
      set({
        callId: call.id,
        peer: call.peer,
        role: 'callee',
        conversationId: call.conversationId,
        error: null,
        lastEndReason: null,
      });
      transition('RINGING');
    },

    handleRinging() {
      if (get().state === 'CALLING') transition('RINGING');
    },

    async acceptCall() {
      const { callId, state } = get();
      if (!callId || state !== 'RINGING') return;

      try {
        session = createSession(callId, 'callee');
        await session.prepareAudio();
        applyVoiceSettings();
      } catch (error) {
        await teardown();
        set({
          error: {
            code: 'MIC',
            message:
              error instanceof Error ? error.message : 'The microphone could not be opened.',
          },
        });
        // Decline rather than leaving the caller ringing into the void.
        await emitWithAck('call:reject', { callId, reason: 'REJECTED' }).catch(
          () => undefined,
        );
        resetToIdle('REJECTED');
        return;
      }

      try {
        await emitWithAck<ActiveCall>('call:accept', { callId });
        transition('ACCEPTED');

        const iceConfig = await fetchIceConfig();
        await session.connect(iceConfig);
        transition('CONNECTING');
        await flushPendingSignals();
        startTickers();
      } catch (error) {
        await teardown();
        const socketError = error as SocketError;
        resetToIdle(null);
        set({
          error: {
            code: socketError.code ?? 'CALL_FAILED',
            message: socketError.message ?? 'The call could not be answered.',
          },
        });
      }
    },

    /** Caller side: the callee picked up, so start media negotiation. */
    async handleAccepted() {
      if (get().role !== 'caller') return;
      if (!transition('ACCEPTED')) return;

      try {
        const iceConfig = await fetchIceConfig();
        if (!session) return;
        await session.connect(iceConfig);
        transition('CONNECTING');
        await flushPendingSignals();
      } catch (error) {
        set({
          error: {
            code: 'WEBRTC_FAILED',
            message:
              error instanceof Error
                ? error.message
                : 'The audio connection could not be set up.',
          },
        });
        await get().endCall('FAILED');
      }
    },

    handleRejected(reason) {
      set({
        error:
          reason === 'BUSY'
            ? { code: 'USER_BUSY', message: `${get().peer?.displayName ?? 'They'} is on another call.` }
            : { code: 'REJECTED', message: `${get().peer?.displayName ?? 'They'} declined the call.` },
      });
    },

    handleEnded(payload) {
      if (payload.callId !== get().callId) return;
      transition('ENDED');
      void teardown().then(() => {
        resetToIdle(payload.reason);
      });
    },

    handleFailed(payload) {
      set({ error: { code: payload.code, message: payload.message } });
      void get().endCall('FAILED');
    },

    handleReconnecting() {
      transition('RECONNECTING');
    },

    async handleRemoteOffer({ callId, description }) {
      if (callId !== get().callId) return;
      if (!session) {
        pendingSignals.offers.push(description);
        return;
      }
      await session.handleRemoteDescription(description);
    },

    async handleRemoteAnswer({ callId, description }) {
      if (callId !== get().callId) return;
      if (!session) {
        pendingSignals.answers.push(description);
        return;
      }
      await session.handleRemoteDescription(description);
    },

    async handleRemoteCandidate({ callId, candidate }) {
      if (callId !== get().callId) return;
      if (!session) {
        pendingSignals.candidates.push(candidate);
        return;
      }
      await session.handleRemoteCandidate(candidate);
    },

    async rejectCall() {
      const { callId } = get();
      if (!callId) return;
      transition('ENDED');
      await emitWithAck('call:reject', { callId, reason: 'REJECTED' }).catch(
        () => undefined,
      );
      await teardown();
      resetToIdle('REJECTED');
    },

    async endCall(reason = 'COMPLETED') {
      const { callId, state } = get();
      if (!callId || state === 'IDLE') return;

      transition('ENDED');
      // The server decides the real reason (a hang-up while ringing is a cancel).
      await emitWithAck('call:end', {
        callId,
        reason: reason === 'FAILED' ? 'FAILED' : 'COMPLETED',
      }).catch(() => undefined);
      await teardown();
      resetToIdle(reason);
    },

    dismissError() {
      set({ error: null, lastEndReason: null });
    },

    async resumeAudio() {
      await session?.resumeRemoteAudio().catch(() => undefined);
      set({ audioBlocked: false });
    },

    toggleMute() {
      const muted = !get().muted;
      set({ muted });
      session?.audioPipeline.setMuted(muted);
    },

    /**
     * The single switch that decides whether the far end hears the real voice.
     * The peer is told too — deliberately, as a transparency measure.
     */
    setVoiceChangerEnabled(enabled) {
      set({ voiceChangerEnabled: enabled });
      const pipeline = session?.audioPipeline;
      pipeline?.setVoiceChangerEnabled(enabled);

      const actuallyOn = pipeline?.isVoiceChangerEnabled ?? false;
      if (enabled && !actuallyOn) {
        // The engine refused. Do not leave the UI claiming it is on.
        set({
          voiceChangerEnabled: false,
          error: {
            code: 'VOICE_UNAVAILABLE',
            message: 'The voice changer could not start, so your normal voice is being sent.',
          },
        });
        return;
      }

      const { callId, preset } = get();
      if (callId) {
        getSocket().emit('call:voice-state', {
          callId,
          enabled: actuallyOn,
          preset: actuallyOn ? preset : null,
        });
      }
      set({ voiceMetrics: pipeline?.getMetrics() ?? null });
    },

    setPreset(preset) {
      set({ preset });
      session?.audioPipeline.setPreset(preset);
      const { callId, voiceChangerEnabled } = get();
      if (callId && voiceChangerEnabled) {
        getSocket().emit('call:voice-state', { callId, enabled: true, preset });
      }
    },

    setIntensity(value) {
      set({ intensity: value });
      session?.audioPipeline.setIntensity(value);
    },

    setOverrides(overrides) {
      set((state) => ({ overrides: { ...state.overrides, ...overrides } }));
      session?.audioPipeline.setOverrides(overrides);
    },

    resetOverrides() {
      set({ overrides: {} });
      session?.audioPipeline.resetOverrides();
    },
  };
});

/** Polls the pipeline for metrics while a call is up. Used by the call UI. */
export function readVoiceMetrics(): VoiceMetrics | null {
  return session?.audioPipeline.getMetrics() ?? null;
}

export function currentSession(): CallSession | null {
  return session;
}

export const selectIsCallActive = (state: CallStoreState): boolean =>
  state.state !== 'IDLE' && state.state !== 'ENDED';
