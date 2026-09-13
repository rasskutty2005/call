/**
 * The decision to run a neural engine has to be wrong in only one direction.
 *
 * Refusing a device that could have coped is a missing feature. Accepting one
 * that cannot is a broken phone call, which the person on the other end also
 * pays for — so every refusal carries a reason, and a CPU-only device is
 * accepted only as "marginal", never as fine.
 */
import { describe, expect, it } from 'vitest';
import { evaluateCapability, type RvcEnvironment } from './capability';

const capable: RvcEnvironment = {
  hasWorker: true,
  hasAudioWorklet: true,
  hasWebGpu: true,
  hasWebGpuAdapter: true,
  hasWasmSimd: true,
  hardwareConcurrency: 8,
  isSecureContext: true,
};

const env = (overrides: Partial<RvcEnvironment>): RvcEnvironment => ({ ...capable, ...overrides });

describe('evaluateCapability', () => {
  it('picks WebGPU when an adapter is actually handed over', () => {
    const result = evaluateCapability(capable);
    expect(result).toMatchObject({ supported: true, backend: 'webgpu', marginal: false });
    expect(result.reasons).toEqual([]);
  });

  it('does not take WebGPU on trust when the adapter is refused', () => {
    // navigator.gpu exists on blocklisted devices; requestAdapter is the truth.
    const result = evaluateCapability(env({ hasWebGpuAdapter: false }));
    expect(result.backend).toBe('wasm');
    expect(result.marginal).toBe(true);
  });

  it('accepts CPU inference but never calls it fine', () => {
    const result = evaluateCapability(env({ hasWebGpu: false, hasWebGpuAdapter: false }));
    expect(result.supported).toBe(true);
    expect(result.marginal).toBe(true);
  });

  it('refuses CPU inference on too few cores, and says how many it saw', () => {
    const result = evaluateCapability(
      env({ hasWebGpu: false, hasWebGpuAdapter: false, hardwareConcurrency: 2 }),
    );
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toContain('2');
  });

  it('still allows a 2-core device when it has a GPU', () => {
    // The core count only gates the CPU path; it is not a proxy for "cheap phone".
    expect(evaluateCapability(env({ hardwareConcurrency: 2 })).supported).toBe(true);
  });

  it('refuses when there is no backend at all', () => {
    const result = evaluateCapability(
      env({ hasWebGpu: false, hasWebGpuAdapter: false, hasWasmSimd: false }),
    );
    expect(result.supported).toBe(false);
    expect(result.backend).toBeNull();
  });

  it.each([
    ['hasAudioWorklet', { hasAudioWorklet: false }, 'AudioWorklet'],
    ['hasWorker', { hasWorker: false }, 'Web Workers'],
    ['isSecureContext', { isSecureContext: false }, 'secure context'],
  ])('refuses without %s and explains why', (_label, overrides, expected) => {
    const result = evaluateCapability(env(overrides as Partial<RvcEnvironment>));
    expect(result.supported).toBe(false);
    expect(result.reasons.join(' ')).toContain(expected);
  });

  it('never reports unsupported without a reason', () => {
    const result = evaluateCapability(env({ hasWorker: false, hasAudioWorklet: false }));
    expect(result.supported).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
