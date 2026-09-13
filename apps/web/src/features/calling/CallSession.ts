import type {
  CallQuality,
  IceConfigResponse,
  RTCIceCandidateLike,
  VoicePresetId,
} from '@sonder/shared';
import { CALL_STATS_INTERVAL_MS } from '@sonder/shared';
import { AudioPipeline } from '@/voice/AudioPipeline';
import { VoiceEngineError } from '@/voice/VoiceConverter';
import {
  isRoutingSupported,
  releaseCallAudioRoute,
  setCallAudioRoute,
  type CallAudioRoute,
} from './audioRoute';

export type CallRole = 'caller' | 'callee';

export interface CallSessionCallbacks {
  /** Send an SDP offer to the peer via the signalling server. */
  sendOffer(description: RTCSessionDescriptionInit): void;
  sendAnswer(description: RTCSessionDescriptionInit): void;
  sendIceCandidate(candidate: RTCIceCandidateLike): void;
  /** The RTCPeerConnection actually reached `connected`. */
  onConnected(): void;
  onReconnecting(): void;
  onFailed(reason: string): void;
  onQuality(quality: CallQuality): void;
  onError(error: Error): void;
  /** Remote audio could not autoplay; the user must tap something. */
  onAudioBlocked(): void;
}

/**
 * One live audio call.
 *
 * Responsibilities, and the boundaries that matter:
 *   - owns the RTCPeerConnection and the AudioPipeline;
 *   - sends only the pipeline's processed track, never the raw microphone;
 *   - reports `onConnected` strictly from RTCPeerConnection state, so the UI's
 *     "Connected" label is derived from a real transport and never a timer;
 *   - implements the W3C "perfect negotiation" pattern so an ICE restart from
 *     either side cannot deadlock the session.
 *
 * It knows nothing about React, stores, or Socket.IO — signalling is injected
 * through callbacks, which is what lets the whole class be reasoned about (and
 * driven) in isolation.
 */
export class CallSession {
  readonly callId: string;
  readonly role: CallRole;

  private pc: RTCPeerConnection | null = null;
  private pipeline: AudioPipeline;
  private remoteAudio: HTMLAudioElement | null = null;
  private remoteStream: MediaStream | null = null;

  /* --- perfect negotiation state (W3C recommended pattern) --------------- */
  /** The callee is "polite": on an offer collision it yields. */
  private readonly polite: boolean;
  private makingOffer = false;
  /** Whether an offer has actually reached the wire. See the check in connect(). */
  private offerSent = false;
  /** Earpiece by default: this is a phone call, not a video. */
  private route: CallAudioRoute = 'earpiece';
  private ignoreOffer = false;
  private settingRemoteAnswerPending = false;
  /**
   * The callee suppresses its own first negotiationneeded: the caller always
   * makes the opening offer, so letting both sides offer at once would cause an
   * avoidable collision on every single call.
   */
  private suppressNegotiation: boolean;

  /** Candidates that arrived before the remote description was set. */
  private pendingCandidates: RTCIceCandidateLike[] = [];

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hasConnected = false;
  private closed = false;
  private lastStats: { packetsLost: number; packetsReceived: number } | null = null;

  constructor(
    options: { callId: string; role: CallRole },
    private readonly callbacks: CallSessionCallbacks,
  ) {
    this.callId = options.callId;
    this.role = options.role;
    this.polite = options.role === 'callee';
    this.suppressNegotiation = options.role === 'callee';

    this.pipeline = new AudioPipeline({
      onError: (error) => this.callbacks.onError(error),
    });
  }

  get audioPipeline(): AudioPipeline {
    return this.pipeline;
  }

  get isConnected(): boolean {
    return this.pc?.connectionState === 'connected';
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc?.connectionState ?? 'new';
  }

  /**
   * Opens the microphone and builds the audio graph. Deliberately separate from
   * (and before) `connect()`: permission must be resolved before anyone's phone
   * starts ringing, so a denied microphone never turns into a dropped call.
   *
   * Every caller must come through here rather than reaching past it to
   * `audioPipeline.start()`. They all did, which left this method unreferenced
   * and made anything added to it dead on arrival — the audio-session claim
   * below was exactly that, shipped and inert.
   */
  async prepareAudio(options: { deviceId?: string } = {}): Promise<void> {
    // Before getUserMedia, not after: the OS decides where a call comes out
    // when the audio session activates, and that is the moment capture starts.
    // Claiming it afterwards means the first part of the call is on speaker.
    setCallAudioRoute(this.route);
    await this.pipeline.start(options);
  }

  /** Whether this browser lets the page influence call routing at all. */
  get isAudioRoutingSupported(): boolean {
    return isRoutingSupported();
  }

  get audioRoute(): CallAudioRoute {
    return this.route;
  }

  /** Returns whether the request reached the OS; it alone decides the output. */
  setAudioRoute(route: CallAudioRoute): boolean {
    this.route = route;
    return setCallAudioRoute(route);
  }

  /**
   * Creates the peer connection and adds the processed track.
   *
   * @param iceConfig fetched from the server; contains ephemeral TURN credentials
   */
  async connect(iceConfig: IceConfigResponse): Promise<void> {
    if (this.closed) return;
    if (!this.pipeline.isStarted) {
      throw new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'The microphone is not ready yet.',
      );
    }

    const pc = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      // 'all' rather than 'relay': try a direct path first and only pay for TURN
      // when the network forces it.
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 2,
    });
    this.pc = pc;

    /*
     * Handlers first, before addTrack and before any await.
     *
     * addTrack sets the negotiation-needed flag, and the event that follows is
     * queued as a task. These assignments used to sit after an
     * `await sender.setParameters(...)`, which hands the event loop back long
     * enough for that task to run — dispatching negotiationneeded at a
     * connection with no listener. The event is then simply gone; the flag does
     * not fire it again.
     *
     * Only the caller offers, since the callee starts with negotiation
     * suppressed. So losing that one event means no offer is ever made, and the
     * call has no failure path at all: nothing throws, ICE never fails because
     * it never starts, and both people watch "connecting" until they give up.
     * Whether the event was lost came down to how fast setParameters resolved,
     * which is why it varied by device.
     */
    pc.onnegotiationneeded = () => {
      void this.onNegotiationNeeded();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.callbacks.sendIceCandidate(event.candidate.toJSON() as RTCIceCandidateLike);
      }
    };
    pc.ontrack = (event) => {
      this.attachRemote(event.streams[0] ?? new MediaStream([event.track]));
    };
    pc.onconnectionstatechange = () => this.onConnectionStateChange();
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        // A failed ICE agent will not recover on its own.
        void this.restartIce();
      }
    };

    const track = this.pipeline.outboundTrack;
    const stream = this.pipeline.outboundStream;
    if (!track || !stream) {
      throw new VoiceEngineError(
        'MIC_UNAVAILABLE',
        'No audio track was produced by the microphone.',
      );
    }

    // THE track that goes out. It comes from the pipeline's destination node, so
    // whatever the voice changer is doing is already baked in. There is no code
    // path that adds the raw microphone track to a peer connection.
    pc.addTrack(track, stream);

    // Voice-optimised transceiver settings. DTX saves bandwidth in silence.
    for (const sender of pc.getSenders()) {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 48_000;
      // Not universally supported; ignore rejection rather than failing the call.
      await sender.setParameters(params).catch(() => undefined);
    }

    this.startStatsSampling();

    /*
     * Confirm the offer actually happened, rather than assuming it did.
     *
     * negotiationneeded fires once per flag set, so anything that swallows it
     * leaves the call with no failure path whatsoever — nothing throws, and ICE
     * never fails because it never starts. That is too quiet a way to lose a
     * call to leave to one event, even with the ordering above fixed.
     *
     * On a later task, so a queued negotiationneeded gets its turn first, and
     * only while the connection is still untouched: stable signalling state, no
     * offer in flight, none already sent. Those conditions cannot hold if
     * negotiation did happen, so this can never produce a second offer.
     */
    if (!this.suppressNegotiation) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (
        !this.closed &&
        this.pc === pc &&
        pc.signalingState === 'stable' &&
        !this.makingOffer &&
        !this.offerSent
      ) {
        console.warn('[call] negotiationneeded never fired; offering explicitly');
        await this.onNegotiationNeeded();
      }
    }
  }

  /** The callee calls this once it has the caller's offer path open. */
  allowNegotiation(): void {
    this.suppressNegotiation = false;
  }

  private async onNegotiationNeeded(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    if (this.suppressNegotiation) return;

    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.offerSent = true;
        this.callbacks.sendOffer(pc.localDescription.toJSON());
      }
    } catch (error) {
      this.callbacks.onError(asError(error, 'Could not start the audio connection.'));
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Handles an inbound offer or answer. This is the perfect-negotiation core:
   * without the collision handling, two simultaneous ICE restarts leave both
   * peers stuck in `have-local-offer` forever.
   */
  async handleRemoteDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    const readyForOffer =
      !this.makingOffer &&
      (pc.signalingState === 'stable' || this.settingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) return;

    try {
      this.settingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      this.settingRemoteAnswerPending = false;

      // Candidates can legally arrive before the description they belong to.
      await this.flushPendingCandidates();

      if (description.type === 'offer') {
        this.suppressNegotiation = false;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.callbacks.sendAnswer(pc.localDescription.toJSON());
        }
      }
    } catch (error) {
      this.settingRemoteAnswerPending = false;
      this.callbacks.onError(asError(error, 'The audio connection could not be negotiated.'));
    }
  }

  async handleRemoteCandidate(candidate: RTCIceCandidateLike): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    if (!pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch (error) {
      // An ignored offer means its candidates are meaningless too.
      if (!this.ignoreOffer) {
        console.warn('[call] could not add ICE candidate', error);
      }
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      await this.handleRemoteCandidate(candidate);
    }
  }

  private onConnectionStateChange(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;

    switch (pc.connectionState) {
      case 'connected':
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        // Only here — with a real transport up — does the call report connected.
        this.hasConnected = true;
        this.callbacks.onConnected();
        break;

      case 'disconnected':
        // Often transient (a Wi-Fi handover). Give it a moment before shouting.
        this.callbacks.onReconnecting();
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.pc?.connectionState === 'disconnected') void this.restartIce();
          }, 3000);
        }
        break;

      case 'failed':
        this.callbacks.onFailed(
          this.hasConnected
            ? 'The connection dropped and could not be re-established.'
            : 'A direct audio connection could not be established. This usually means a TURN relay is needed.',
        );
        break;

      default:
        break;
    }
  }

  /**
   * ICE restart: gathers fresh candidates over the existing session.
   *
   * Only the impolite peer (the caller) initiates, so both sides do not restart
   * at once. The polite peer just reports that it is reconnecting and waits.
   */
  private async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed || !this.hasConnected) return;

    this.callbacks.onReconnecting();
    if (this.polite) return;

    try {
      this.makingOffer = true;
      pc.restartIce();
      await pc.setLocalDescription();
      if (pc.localDescription) {
        this.offerSent = true;
        this.callbacks.sendOffer(pc.localDescription.toJSON());
      }
    } catch (error) {
      console.warn('[call] ICE restart failed', error);
    } finally {
      this.makingOffer = false;
    }
  }

  /* --- remote audio ------------------------------------------------------ */

  private attachRemote(stream: MediaStream): void {
    this.remoteStream = stream;
    if (!this.remoteAudio) {
      this.remoteAudio = document.createElement('audio');
      this.remoteAudio.autoplay = true;
      // Not muted, and never recorded: this element only plays.
      this.remoteAudio.setAttribute('playsinline', 'true');
      this.remoteAudio.style.display = 'none';
      document.body.appendChild(this.remoteAudio);
    }
    this.remoteAudio.srcObject = stream;
    void this.remoteAudio.play().catch(() => {
      // Autoplay policy blocked it; the UI has to offer a tap-to-listen button.
      this.callbacks.onAudioBlocked();
    });
  }

  /** Retry playback after a user gesture, for the autoplay-blocked case. */
  async resumeRemoteAudio(): Promise<void> {
    if (!this.remoteAudio) return;
    await this.remoteAudio.play();
  }

  setRemoteVolume(volume: number): void {
    if (this.remoteAudio) this.remoteAudio.volume = Math.min(1, Math.max(0, volume));
  }

  get isSpeakerSelectionSupported(): boolean {
    return (
      typeof HTMLMediaElement !== 'undefined' &&
      'setSinkId' in HTMLMediaElement.prototype
    );
  }

  /** Chromium-only; other browsers follow the OS default output. */
  async setAudioOutput(deviceId: string): Promise<void> {
    if (!this.remoteAudio || !this.isSpeakerSelectionSupported) return;
    await (
      this.remoteAudio as HTMLAudioElement & {
        setSinkId(id: string): Promise<void>;
      }
    ).setSinkId(deviceId);
  }

  /* --- quality ----------------------------------------------------------- */

  private startStatsSampling(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.sampleStats();
    }, CALL_STATS_INTERVAL_MS);
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    try {
      const report = await pc.getStats();
      let rttMs: number | null = null;
      let jitterMs: number | null = null;
      let packetsLost: number | null = null;
      let packetsReceived: number | null = null;

      report.forEach((stat) => {
        if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
          const rtt = (stat as { currentRoundTripTime?: number }).currentRoundTripTime;
          if (typeof rtt === 'number') rttMs = Math.round(rtt * 1000);
        }
        if (stat.type === 'inbound-rtp' && (stat as { kind?: string }).kind === 'audio') {
          const inbound = stat as {
            jitter?: number;
            packetsLost?: number;
            packetsReceived?: number;
          };
          if (typeof inbound.jitter === 'number') {
            jitterMs = Math.round(inbound.jitter * 1000);
          }
          if (typeof inbound.packetsLost === 'number') packetsLost = inbound.packetsLost;
          if (typeof inbound.packetsReceived === 'number') {
            packetsReceived = inbound.packetsReceived;
          }
        }
      });

      // Loss over the last interval, not since the call began — a cumulative
      // figure makes a call that recovered look permanently bad.
      let lossPct: number | null = null;
      if (packetsLost !== null && packetsReceived !== null) {
        const previous = this.lastStats;
        if (previous) {
          const deltaLost = Math.max(0, packetsLost - previous.packetsLost);
          const deltaReceived = Math.max(0, packetsReceived - previous.packetsReceived);
          const total = deltaLost + deltaReceived;
          lossPct = total > 0 ? (deltaLost / total) * 100 : 0;
        }
        this.lastStats = { packetsLost, packetsReceived };
      }

      this.callbacks.onQuality({
        rttMs,
        jitterMs,
        packetsLostPct: lossPct,
        level: gradeQuality(rttMs, jitterMs, lossPct),
      });
    } catch {
      // Stats are best-effort; never fail a call over them.
    }
  }

  /** Reports what this client is doing to its own audio, for history/UI. */
  getVoiceState(): { enabled: boolean; preset: VoicePresetId | null } {
    const enabled = this.pipeline.isVoiceChangerEnabled;
    return { enabled, preset: enabled ? this.pipeline.preset : null };
  }

  /* --- teardown ---------------------------------------------------------- */

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Give the audio session back, or every video on the site afterwards is
    // still treated as a phone call and plays out of the earpiece.
    releaseCallAudioRoute();

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pc) {
      // Detach handlers before closing so a teardown-triggered state change does
      // not fire callbacks into an unmounted UI.
      this.pc.onnegotiationneeded = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      for (const sender of this.pc.getSenders()) {
        try {
          this.pc.removeTrack(sender);
        } catch {
          // Connection may already be closing.
        }
      }
      this.pc.close();
      this.pc = null;
    }

    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
    this.remoteStream = null;

    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }

    await this.pipeline.stop();
    this.pendingCandidates = [];
  }
}

/**
 * Maps raw transport numbers onto the four buckets the signal-bars indicator
 * shows. Thresholds follow the usual VoIP rules of thumb: under 150 ms one-way
 * is transparent, 3% loss is where Opus starts to sound patchy.
 */
export function gradeQuality(
  rttMs: number | null,
  jitterMs: number | null,
  lossPct: number | null,
): CallQuality['level'] {
  if (rttMs === null && jitterMs === null && lossPct === null) return 'unknown';

  const rtt = rttMs ?? 0;
  const jitter = jitterMs ?? 0;
  const loss = lossPct ?? 0;

  if (loss > 8 || rtt > 600) return 'critical';
  if (loss > 3 || rtt > 300 || jitter > 60) return 'poor';
  if (loss > 1 || rtt > 150 || jitter > 30) return 'good';
  return 'excellent';
}

function asError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  return new Error(fallback);
}
