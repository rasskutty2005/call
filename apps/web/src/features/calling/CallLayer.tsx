'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  Ear,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ShieldAlert,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import { isRoutingSupported, type CallAudioRoute } from './audioRoute';
import type { CallState } from '@sonder/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/feedback';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/overlay';
import { UserAvatar } from '@/components/ui/avatar';
import { useCallStore } from '@/store/call';
import { useUiStore } from '@/store/ui';
import { currentSession } from '@/store/call';
import { cn, formatDuration } from '@/lib/utils';
import { CallQualityIndicator } from './CallQualityIndicator';
import { VoiceChangerPanel } from './VoiceChangerPanel';

/**
 * Renders the call experience above everything else.
 *
 * Mounted once in Providers, so an incoming call reaches the user no matter
 * which page they are on — including mid-scroll through the feed.
 */
export function CallLayer() {
  const state = useCallStore((store) => store.state);
  const role = useCallStore((store) => store.role);
  const error = useCallStore((store) => store.error);
  const lastEndReason = useCallStore((store) => store.lastEndReason);
  const dismissError = useCallStore((store) => store.dismissError);

  // Errors and end-of-call summaries are surfaced as toasts rather than another
  // modal, so they cannot block the next call.
  React.useEffect(() => {
    if (!error) return;
    toast.error(error.message, { id: `call-error-${error.code}` });
    const timer = setTimeout(dismissError, 100);
    return () => clearTimeout(timer);
  }, [error, dismissError]);

  React.useEffect(() => {
    if (!lastEndReason) return;
    const messages: Partial<Record<string, string>> = {
      COMPLETED: 'Call ended',
      CANCELLED: 'Call cancelled',
      REJECTED: 'Call declined',
      BUSY: 'They were on another call',
      TIMEOUT: 'No answer',
      UNAVAILABLE: 'They were unavailable',
      FAILED: 'The call failed',
    };
    const message = messages[lastEndReason];
    if (message) toast(message, { id: 'call-ended' });
  }, [lastEndReason]);

  if (state === 'IDLE') return null;

  const isIncomingRing = state === 'RINGING' && role === 'callee';
  return isIncomingRing ? <IncomingCallScreen /> : <ActiveCallScreen />;
}

/* -------------------------------------------------------------------------- */
/* Incoming                                                                   */
/* -------------------------------------------------------------------------- */

function IncomingCallScreen() {
  const peer = useCallStore((store) => store.peer);
  const accept = useCallStore((store) => store.acceptCall);
  const reject = useCallStore((store) => store.rejectCall);
  const [busy, setBusy] = React.useState<'accept' | 'reject' | null>(null);

  if (!peer) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Incoming call from ${peer.displayName}`}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-gradient-to-b from-[hsl(266_60%_16%)] via-[hsl(280_45%_11%)] to-background px-6 py-14 text-white animate-fade-in"
      style={{ minHeight: 'var(--app-height)' }}
    >
      <div className="flex flex-col items-center gap-2 pt-6">
        <Badge variant="secondary" className="bg-white/15 text-white">
          Incoming audio call
        </Badge>
      </div>

      <div className="flex flex-col items-center gap-6">
        <div className="relative flex items-center justify-center">
          {/* Two offset pulses read as "ringing" without being a spinner. */}
          <span className="absolute size-40 rounded-full bg-white/25 animate-call-pulse" />
          <span
            className="absolute size-40 rounded-full bg-white/20 animate-call-pulse"
            style={{ animationDelay: '0.9s' }}
          />
          <UserAvatar
            displayName={peer.displayName}
            username={peer.username}
            avatarUrl={peer.avatarUrl}
            size="3xl"
            className="relative ring-4 ring-white/25"
          />
        </div>

        <div className="space-y-1 text-center">
          <h2 className="font-display text-3xl font-bold">{peer.displayName}</h2>
          <p className="text-white/70">@{peer.username}</p>
          <p className="pt-2 text-sm text-white/80">is calling you…</p>
        </div>
      </div>

      <div className="flex w-full max-w-sm items-center justify-around gap-8 pb-6">
        <div className="flex flex-col items-center gap-2">
          <Button
            variant="destructive"
            size="icon-lg"
            className="size-16 shadow-lifted"
            onClick={() => {
              setBusy('reject');
              void reject().finally(() => setBusy(null));
            }}
            loading={busy === 'reject'}
            aria-label="Decline call"
          >
            <PhoneOff className="size-7" aria-hidden />
          </Button>
          <span className="text-xs font-medium text-white/70">Decline</span>
        </div>

        <div className="flex flex-col items-center gap-2">
          <Button
            variant="success"
            size="icon-lg"
            className="size-16 shadow-lifted"
            onClick={() => {
              setBusy('accept');
              void accept().finally(() => setBusy(null));
            }}
            loading={busy === 'accept'}
            aria-label="Accept call"
          >
            <Phone className="size-7" aria-hidden />
          </Button>
          <span className="text-xs font-medium text-white/70">Accept</span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Active                                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Record<CallState, string> = {
  IDLE: '',
  CALLING: 'Calling…',
  RINGING: 'Ringing…',
  ACCEPTED: 'Connecting…',
  CONNECTING: 'Connecting…',
  CONNECTED: 'Connected',
  RECONNECTING: 'Reconnecting…',
  ENDED: 'Call ended',
};

function ActiveCallScreen() {
  const state = useCallStore((store) => store.state);
  const peer = useCallStore((store) => store.peer);
  const duration = useCallStore((store) => store.durationSec);
  const muted = useCallStore((store) => store.muted);
  const toggleMute = useCallStore((store) => store.toggleMute);
  const endCall = useCallStore((store) => store.endCall);
  const quality = useCallStore((store) => store.quality);
  const hasTurn = useCallStore((store) => store.hasTurn);
  const voiceOn = useCallStore((store) => store.voiceChangerEnabled);
  const setVoiceEnabled = useCallStore((store) => store.setVoiceChangerEnabled);
  const outputLevel = useCallStore((store) => store.outputLevel);
  const audioBlocked = useCallStore((store) => store.audioBlocked);
  const resumeAudio = useCallStore((store) => store.resumeAudio);
  const peerVoiceEnabled = useUiStore((store) => store.peerVoiceEnabled);
  const panelOpen = useUiStore((store) => store.voicePanelOpen);
  const setPanelOpen = useUiStore((store) => store.setVoicePanelOpen);

  const [speakerOn, setSpeakerOn] = React.useState(true);
  const [ending, setEnding] = React.useState(false);

  // Read after mount, never during render: it inspects a browser API that does
  // not exist on the server, and a control that appears only after hydration is
  // better than markup that disagrees with itself.
  const [routingSupported, setRoutingSupported] = React.useState(false);
  const [route, setRoute] = React.useState<CallAudioRoute>('earpiece');
  React.useEffect(() => {
    setRoutingSupported(isRoutingSupported());
  }, []);

  if (!peer) return null;

  const connected = state === 'CONNECTED';

  const handleSpeaker = () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    // Volume is the portable control; setSinkId is Chromium-only and is exposed
    // through the device picker instead.
    currentSession()?.setRemoteVolume(next ? 1 : 0);
  };

  const handleRoute = () => {
    const next: CallAudioRoute = route === 'earpiece' ? 'speaker' : 'earpiece';
    setRoute(next);
    currentSession()?.setAudioRoute(next);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${peer.displayName}`}
      className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-b from-[hsl(266_55%_15%)] via-[hsl(275_40%_10%)] to-background text-white animate-fade-in"
      style={{ minHeight: 'var(--app-height)' }}
    >
      {/* Header */}
      <header className="flex items-center justify-between px-5 pt-safe">
        <div className="flex items-center gap-2 py-4">
          <CallQualityIndicator quality={quality} className="text-white" />
          <span className="text-xs text-white/70">{STATUS_LABEL[state]}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white/70 hover:bg-white/10 hover:text-white"
          onClick={() => setPanelOpen(true)}
          aria-label="Voice settings"
        >
          <Wand2 aria-hidden />
        </Button>
      </header>

      {/* Warnings */}
      <div className="space-y-2 px-5">
        {!hasTurn && (state === 'CONNECTING' || state === 'ACCEPTED') ? (
          <Notice tone="warning">
            No TURN relay is configured. If a direct connection cannot be made,
            this call will fail.
          </Notice>
        ) : null}
        {state === 'RECONNECTING' ? (
          <Notice tone="warning">
            Connection lost — trying to reconnect. Stay on the line.
          </Notice>
        ) : null}
        {audioBlocked ? (
          <Notice tone="warning" action={{ label: 'Enable sound', onClick: () => void resumeAudio() }}>
            Your browser blocked audio playback.
          </Notice>
        ) : null}
        {peerVoiceEnabled ? (
          <Notice tone="info">
            {peer.displayName} is using a voice changer.
          </Notice>
        ) : null}
      </div>

      {/* Peer */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="relative">
          {connected ? (
            <span
              aria-hidden
              className="absolute -inset-3 rounded-full border-2 border-white/25 transition-transform duration-100"
              style={{ transform: `scale(${1 + outputLevel * 0.12})` }}
            />
          ) : (
            <span className="absolute -inset-3 rounded-full bg-white/15 animate-call-pulse" />
          )}
          <UserAvatar
            displayName={peer.displayName}
            username={peer.username}
            avatarUrl={peer.avatarUrl}
            size="3xl"
            className="relative ring-4 ring-white/20"
          />
        </div>

        <div className="space-y-1.5 text-center">
          <h2 className="font-display text-3xl font-bold">{peer.displayName}</h2>
          <p className="tabular text-lg text-white/80">
            {connected ? formatDuration(duration) : STATUS_LABEL[state]}
          </p>
          {voiceOn ? (
            <Badge className="mt-2 bg-white/15 text-white" variant="secondary">
              <Wand2 className="size-3" aria-hidden /> Voice changer on
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Controls */}
      <div className="px-6 pb-10 pb-safe">
        <div
          className={`mx-auto grid max-w-sm gap-3 ${routingSupported ? 'grid-cols-5' : 'grid-cols-4'}`}
        >
          <ControlButton
            active={!muted}
            onClick={toggleMute}
            icon={muted ? MicOff : Mic}
            label={muted ? 'Unmute' : 'Mute'}
            danger={muted}
          />
          <ControlButton
            active={speakerOn}
            onClick={handleSpeaker}
            icon={speakerOn ? Volume2 : VolumeX}
            label={speakerOn ? 'Speaker' : 'Muted'}
          />
          {routingSupported ? (
            <ControlButton
              active={route === 'speaker'}
              onClick={handleRoute}
              icon={route === 'speaker' ? Volume2 : Ear}
              label={route === 'speaker' ? 'Speaker' : 'Earpiece'}
            />
          ) : null}
          <ControlButton
            active={voiceOn}
            onClick={() => setVoiceEnabled(!voiceOn)}
            icon={Wand2}
            label="Voice"
            highlight={voiceOn}
          />
          <div className="flex flex-col items-center gap-1.5">
            <Button
              variant="destructive"
              size="icon-lg"
              className="size-14"
              onClick={() => {
                setEnding(true);
                void endCall('COMPLETED').finally(() => setEnding(false));
              }}
              loading={ending}
              aria-label="End call"
            >
              <PhoneOff aria-hidden />
            </Button>
            <span className="text-[0.7rem] font-medium text-white/70">End</span>
          </div>
        </div>
      </div>

      {/* Voice settings sheet */}
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85vh] overflow-y-auto scroll-area text-foreground sm:mx-auto sm:max-w-lg"
        >
          <div className="flex items-center justify-between">
            <SheetTitle>Voice</SheetTitle>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPanelOpen(false)}
              aria-label="Close voice settings"
            >
              <X aria-hidden />
            </Button>
          </div>
          <VoiceChangerPanel />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ControlButton({
  active,
  onClick,
  icon: Icon,
  label,
  danger,
  highlight,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Mic;
  label: string;
  danger?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        // 56px targets: comfortably thumb-reachable on a phone held one-handed.
        className={cn(
          'flex size-14 items-center justify-center rounded-full transition-all active:scale-95',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70',
          highlight
            ? 'bg-brand-gradient text-white shadow-glow'
            : danger
              ? 'bg-white text-[hsl(266_55%_15%)]'
              : 'bg-white/15 text-white hover:bg-white/25',
        )}
      >
        <Icon className="size-6" aria-hidden />
      </button>
      <span className="text-[0.7rem] font-medium text-white/70">{label}</span>
    </div>
  );
}

function Notice({
  tone,
  children,
  action,
}: {
  tone: 'warning' | 'info';
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-xs',
        tone === 'warning'
          ? 'bg-signal-poor/20 text-signal-poor'
          : 'bg-white/10 text-white/80',
      )}
    >
      <ShieldAlert className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 leading-relaxed">{children}</span>
      {action ? (
        <Button
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 bg-white/20 text-white hover:bg-white/30"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
