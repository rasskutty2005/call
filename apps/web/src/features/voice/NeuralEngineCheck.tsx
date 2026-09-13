'use client';

import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/feedback';
import { probeRvcCapability, type RvcCapability } from '@/voice/rvc/capability';

/**
 * Asks this device, not a user-agent string, whether it could run neural voice
 * conversion.
 *
 * It exists because the answer decides an architecture. Running the model in the
 * browser keeps audio on the device and costs nothing to host, but only if the
 * phones people actually use can keep up. A laptop with WebGPU says yes to
 * almost anything, so the only answer worth having comes from the hardware in
 * question — which is why this is a button in Settings and not a table of
 * devices in a document.
 *
 * It reports capability, never quality: whether the APIs exist and which backend
 * would be chosen. Whether inference beats the clock needs a model and a
 * measurement, and is a separate, later question.
 */
export function NeuralEngineCheck() {
  const [capability, setCapability] = React.useState<RvcCapability | null>(null);
  const [checking, setChecking] = React.useState(false);

  const check = async () => {
    setChecking(true);
    try {
      setCapability(await probeRvcCapability());
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">Neural engine: can this device run it?</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A neural model converts a voice far more convincingly than the DSP
            engine, and costs much more to run. Whether it belongs in the browser
            depends on the phone in your hand, so ask it directly.
          </p>

          {capability ? (
            <div className="mt-3 space-y-2">
              {capability.supported ? (
                <Badge variant={capability.marginal ? 'warning' : 'success'}>
                  {capability.marginal
                    ? 'Possible on CPU, likely too slow for a live call'
                    : 'Supported via WebGPU'}
                </Badge>
              ) : (
                <Badge variant="destructive">Not possible on this device</Badge>
              )}

              {capability.reasons.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {capability.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}

              {/* The raw findings, because "it says no" is not a bug report. */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <Finding label="WebGPU" value={capability.environment.hasWebGpu ? 'present' : 'absent'} />
                <Finding
                  label="GPU adapter"
                  value={capability.environment.hasWebGpuAdapter ? 'granted' : 'refused'}
                />
                <Finding label="WASM SIMD" value={capability.environment.hasWasmSimd ? 'yes' : 'no'} />
                <Finding label="CPU cores" value={String(capability.environment.hardwareConcurrency)} />
                <Finding label="Backend" value={capability.backend ?? 'none'} />
                <Finding
                  label="AudioWorklet"
                  value={capability.environment.hasAudioWorklet ? 'yes' : 'no'}
                />
              </dl>
            </div>
          ) : null}

          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={check}
            loading={checking}
          >
            {capability ? 'Check again' : 'Check this device'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Finding({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
