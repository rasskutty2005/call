'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import {
  DEFAULT_INTENSITY,
  DEFAULT_VOICE_PRESET,
  VOICE_FFT_SIZE,
  VOICE_HOP_SIZE,
  VOICE_PRESET_LIST,
} from '@sonder/shared';
import {
  Cpu,
  LogOut,
  Mic,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Separator } from '@/components/ui/feedback';
import { OptionRow, Slider, Switch } from '@/components/ui/controls';
import { useAuthStore } from '@/store/auth';
import { useCallStore } from '@/store/call';
import { AudioPipeline } from '@/voice/AudioPipeline';
import { VoiceConverterFactory } from '@/voice/VoiceConverterFactory';
import { NeuralEngineCheck } from '@/features/voice/NeuralEngineCheck';
import { cn } from '@/lib/utils';

/**
 * Settings that actually change behaviour. Voice defaults set here are applied
 * to the next call, and the microphone test runs the genuine pipeline so you can
 * hear the conversion before you use it on someone.
 */
export default function SettingsPage() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const preset = useCallStore((state) => state.preset);
  const intensity = useCallStore((state) => state.intensity);
  const setPreset = useCallStore((state) => state.setPreset);
  const setIntensity = useCallStore((state) => state.setIntensity);
  const { theme, setTheme } = useTheme();

  const [supported, setSupported] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    setSupported(AudioPipeline.isSupported());
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as @{user?.username}
        </p>
      </header>

      {/* Appearance */}
      <Section title="Appearance">
        <div className="grid grid-cols-3 gap-2">
          {[
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
            { value: 'system', label: 'System', icon: Monitor },
          ].map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setTheme(option.value)}
              aria-pressed={theme === option.value}
              className={cn(
                'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm font-medium transition-colors',
                theme === option.value
                  ? 'border-primary bg-primary/[0.07]'
                  : 'border-border hover:bg-secondary/60',
              )}
            >
              <option.icon className="size-5" aria-hidden />
              {option.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Voice */}
      <Section
        title="Voice changer"
        description="Defaults for new calls. You can still change these mid-call."
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-white">
                <Cpu className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">Engine: real-time DSP</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Phase-vocoder pitch shifting with independent cepstral formant
                  warping, running in an AudioWorklet on your device. {VOICE_FFT_SIZE}
                  -point STFT, {VOICE_HOP_SIZE}-sample hop, about{' '}
                  {((VOICE_FFT_SIZE / 48000) * 1000).toFixed(0)} ms of added latency.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  This is signal processing, not machine learning. Nothing here is
                  AI-powered, and no audio is uploaded.
                </p>
                {supported === false ? (
                  <Badge variant="destructive" className="mt-2">
                    Not supported in this browser
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>

          <NeuralEngineCheck />

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Default preset
            </h3>
            <div role="radiogroup" className="space-y-2">
              {VOICE_PRESET_LIST.map((option) => (
                <OptionRow
                  key={option.id}
                  selected={preset === option.id}
                  title={option.label}
                  description={option.description}
                  onSelect={() => setPreset(option.id)}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label
                htmlFor="default-intensity"
                className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              >
                Default intensity
              </label>
              <span className="tabular text-xs font-medium">
                {Math.round(intensity * 100)}%
              </span>
            </div>
            <Slider
              id="default-intensity"
              value={[intensity]}
              onValueChange={([value]) => setIntensity(value ?? DEFAULT_INTENSITY)}
              min={0}
              max={1}
              step={0.01}
            />
          </div>

          <MicrophoneTest />
        </div>
      </Section>

      {/* Privacy */}
      <Section title="Privacy">
        <ul className="space-y-3 text-sm">
          {[
            'Your microphone is only opened when you start or answer a call, and is released the moment the call ends.',
            'Voice conversion runs entirely on your device. No audio is uploaded to any server for processing.',
            'Calls are not recorded. There is no recording feature in this build.',
            'When you turn the voice changer on, the other person is told — this is deliberate and cannot be disabled.',
            'Audio travels peer-to-peer over WebRTC and is encrypted in transit (DTLS-SRTP). A TURN relay only forwards encrypted packets when a direct path is impossible.',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2.5">
              <ShieldCheck
                className="mt-0.5 size-4 shrink-0 text-signal-excellent"
                aria-hidden
              />
              <span className="leading-relaxed text-muted-foreground">{line}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Separator className="my-8" />

      <Button variant="destructive" className="w-full sm:w-auto" onClick={() => void logout()}>
        <LogOut aria-hidden />
        Log out
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="font-display text-lg font-bold">{title}</h2>
      {description ? (
        <p className="mb-3 mt-0.5 text-sm text-muted-foreground">{description}</p>
      ) : (
        <div className="mb-3" />
      )}
      {children}
    </section>
  );
}

/**
 * Runs the genuine AudioPipeline against the microphone so you can hear the
 * conversion before using it on a call. Monitoring is off by default because
 * hearing yourself through speakers causes feedback — headphones recommended.
 */
function MicrophoneTest() {
  const preset = useCallStore((state) => state.preset);
  const intensity = useCallStore((state) => state.intensity);

  const pipelineRef = React.useRef<AudioPipeline | null>(null);
  const monitorRef = React.useRef<HTMLAudioElement | null>(null);
  const [running, setRunning] = React.useState(false);
  const [monitoring, setMonitoring] = React.useState(false);
  const [converted, setConverted] = React.useState(true);
  const [level, setLevel] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setLevel(pipelineRef.current?.getOutputLevel() ?? 0);
    }, 100);
    return () => clearInterval(timer);
  }, [running]);

  React.useEffect(() => {
    pipelineRef.current?.setPreset(preset);
    pipelineRef.current?.setIntensity(intensity);
  }, [preset, intensity]);

  // Always release the microphone when leaving the page.
  React.useEffect(
    () => () => {
      void pipelineRef.current?.stop();
      monitorRef.current?.remove();
    },
    [],
  );

  async function start() {
    setError(null);
    try {
      const pipeline = new AudioPipeline({
        onError: (engineError) => setError(engineError.userMessage),
      });
      const stream = await pipeline.start();
      pipeline.setPreset(preset);
      pipeline.setIntensity(intensity);
      pipeline.setVoiceChangerEnabled(converted);
      pipelineRef.current = pipeline;

      const element = document.createElement('audio');
      element.srcObject = stream;
      element.autoplay = true;
      element.volume = monitoring ? 1 : 0;
      element.style.display = 'none';
      document.body.appendChild(element);
      monitorRef.current = element;

      setRunning(true);
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : 'The microphone could not be opened.',
      );
    }
  }

  async function stop() {
    await pipelineRef.current?.stop();
    pipelineRef.current = null;
    monitorRef.current?.remove();
    monitorRef.current = null;
    setRunning(false);
    setLevel(0);
  }

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <Mic className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Test your microphone</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Runs the real conversion pipeline. Use headphones before turning on
            monitoring, or you will get feedback.
          </p>
        </div>
      </div>

      {/* Level meter reflects the processed signal that would be sent. */}
      <div
        className="h-2 overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-valuenow={Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Microphone level"
      >
        <div
          className="h-full rounded-full bg-brand-gradient transition-[width] duration-100"
          style={{ width: `${Math.min(100, level * 100)}%` }}
        />
      </div>

      {running ? (
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <Wand2 className="size-4 text-muted-foreground" aria-hidden />
              Apply conversion
            </span>
            <Switch
              checked={converted}
              onCheckedChange={(next) => {
                setConverted(next);
                pipelineRef.current?.setVoiceChangerEnabled(next);
              }}
            />
          </label>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <Mic className="size-4 text-muted-foreground" aria-hidden />
              Hear yourself
            </span>
            <Switch
              checked={monitoring}
              onCheckedChange={(next) => {
                setMonitoring(next);
                if (monitorRef.current) monitorRef.current.volume = next ? 1 : 0;
              }}
            />
          </label>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        variant={running ? 'outline' : 'secondary'}
        size="sm"
        className="w-full"
        onClick={() => (running ? void stop() : void start())}
        disabled={VoiceConverterFactory.availableTypes()[0]?.available === false}
      >
        {running ? 'Stop test' : 'Start microphone test'}
      </Button>
    </div>
  );
}
