/**
 * Can this device run neural voice conversion during a live call?
 *
 * Asked honestly, and answered before anything downloads a model. A phone that
 * cannot keep up must not silently fall back while the UI still says "AI Voice"
 * — the rule the DSP engine already follows is that the app never claims to be
 * running something it is not.
 *
 * Two thresholds matter and they are different questions:
 *
 *   supported  — the APIs exist at all. Cheap, synchronous-ish, no download.
 *   realtime   — inference actually finishes faster than audio arrives. Only a
 *                measurement on the real device answers this, and it is the one
 *                that decides whether a call is usable.
 *
 * The second cannot be guessed from a user-agent string, and guessing from
 * "is it mobile" is how you ship something that works on the reviewer's Pixel
 * and not on anybody else's phone.
 */

export type RvcBackend = 'webgpu' | 'wasm';

/** Everything the decision depends on, gathered separately so it can be tested. */
export interface RvcEnvironment {
  hasWorker: boolean;
  hasAudioWorklet: boolean;
  hasWebGpu: boolean;
  /** WebGPU can be present and still refuse an adapter, e.g. on a blocklist. */
  hasWebGpuAdapter: boolean;
  hasWasmSimd: boolean;
  hardwareConcurrency: number;
  isSecureContext: boolean;
}

export interface RvcCapability {
  supported: boolean;
  backend: RvcBackend | null;
  /** Present whenever `supported` is false, in the user's terms, not the spec's. */
  reasons: string[];
  /** True when the chosen backend is unlikely to hold real time on this device. */
  marginal: boolean;
  environment: RvcEnvironment;
}

/**
 * Pure decision, given a gathered environment.
 *
 * WASM is deliberately still "supported": it is slow, not absent, and on a
 * laptop it is genuinely fine. It is flagged `marginal` so the caller can warn
 * and measure rather than refuse outright — but below four cores it is refused,
 * because neural conversion plus WebRTC plus the browser on two cores is not a
 * phone call, it is a stutter.
 */
export function evaluateCapability(environment: RvcEnvironment): RvcCapability {
  const reasons: string[] = [];

  if (!environment.isSecureContext) {
    reasons.push('This page is not a secure context, so audio processing is unavailable.');
  }
  if (!environment.hasAudioWorklet) {
    reasons.push('This browser has no AudioWorklet, which the audio path requires.');
  }
  if (!environment.hasWorker) {
    reasons.push('This browser has no Web Workers, so inference cannot leave the audio thread.');
  }

  const gpu = environment.hasWebGpu && environment.hasWebGpuAdapter;
  if (!gpu && !environment.hasWasmSimd) {
    reasons.push('This browser has neither WebGPU nor WebAssembly SIMD, so there is nothing to run the model on.');
  }
  if (!gpu && environment.hasWasmSimd && environment.hardwareConcurrency < 4) {
    reasons.push(
      `Without WebGPU this needs at least 4 CPU cores and this device reports ${environment.hardwareConcurrency}.`,
    );
  }

  if (reasons.length > 0) {
    return { supported: false, backend: null, reasons, marginal: false, environment };
  }

  const backend: RvcBackend = gpu ? 'webgpu' : 'wasm';
  return {
    supported: true,
    backend,
    reasons: [],
    // A CPU fallback is where this stops being real time first, so say so up
    // front and let the measurement confirm or deny it.
    marginal: backend === 'wasm',
    environment,
  };
}

/** Reads the actual browser. Everything it touches may be absent. */
export async function probeEnvironment(): Promise<RvcEnvironment> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  let hasWebGpuAdapter = false;
  if (gpu) {
    try {
      hasWebGpuAdapter = (await gpu.requestAdapter()) !== null;
    } catch {
      hasWebGpuAdapter = false;
    }
  }

  return {
    hasWorker: typeof Worker !== 'undefined',
    hasAudioWorklet: typeof AudioWorkletNode !== 'undefined',
    hasWebGpu: Boolean(gpu),
    hasWebGpuAdapter,
    hasWasmSimd: detectWasmSimd(),
    hardwareConcurrency: navigator.hardwareConcurrency ?? 1,
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : true,
  };
}

export async function probeRvcCapability(): Promise<RvcCapability> {
  return evaluateCapability(await probeEnvironment());
}

/**
 * The documented 8-byte probe module that uses one SIMD opcode (v128.const).
 * A browser without SIMD fails to compile it rather than reporting anything.
 */
function detectWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
        8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}
