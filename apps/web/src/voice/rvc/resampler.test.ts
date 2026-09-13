/**
 * The tests that matter here are about state, not arithmetic.
 *
 * A resampler is easy to write correctly for one buffer and easy to get wrong
 * across a stream, and the wrong version sounds fine in a unit test that hands it
 * the whole signal at once. So the central assertion is that chunked input
 * produces the same samples as the entire signal — that is the bug that would
 * otherwise ship as a click at every buffer boundary.
 */
import { describe, expect, it } from 'vitest';
import { StreamingResampler } from './resampler';

function sine(frequency: number, sampleRate: number, samples: number): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

/** Magnitude at one frequency, via Goertzel. Enough to ask "is the tone there?". */
function magnitudeAt(signal: Float32Array, frequency: number, sampleRate: number): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (const sample of signal) {
    const s0 = sample + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (signal.length / 2);
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

describe('StreamingResampler', () => {
  it('produces the same samples chunked as it does whole', () => {
    // The reason this class exists. Independent per-chunk resampling restarts
    // the phase each time and clicks at every boundary.
    const input = sine(440, 48000, 4800);

    const whole = new StreamingResampler(48000, 16000).process(input);

    const streaming = new StreamingResampler(48000, 16000);
    const chunks: Float32Array[] = [];
    for (let offset = 0; offset < input.length; offset += 128) {
      chunks.push(streaming.process(input.subarray(offset, offset + 128)));
    }
    const pieced = concat(chunks);

    const compared = Math.min(whole.length, pieced.length);
    expect(compared).toBeGreaterThan(1000);
    for (let i = 0; i < compared; i += 1) {
      expect(pieced[i]).toBeCloseTo(whole[i], 6);
    }
  });

  it('survives ragged chunk sizes, which is what a real audio path delivers', () => {
    const input = sine(300, 48000, 6000);
    const whole = new StreamingResampler(48000, 16000).process(input);

    const streaming = new StreamingResampler(48000, 16000);
    const sizes = [1, 7, 128, 3, 512, 64, 1000];
    const chunks: Float32Array[] = [];
    let offset = 0;
    let i = 0;
    while (offset < input.length) {
      const size = sizes[i % sizes.length];
      chunks.push(streaming.process(input.subarray(offset, offset + size)));
      offset += size;
      i += 1;
    }
    const pieced = concat(chunks);

    const compared = Math.min(whole.length, pieced.length);
    for (let n = 0; n < compared; n += 1) expect(pieced[n]).toBeCloseTo(whole[n], 6);
  });

  it('keeps the tone at its original frequency when downsampling', () => {
    const output = new StreamingResampler(48000, 16000).process(sine(440, 48000, 48000));
    expect(magnitudeAt(output, 440, 16000)).toBeGreaterThan(0.4);
    expect(magnitudeAt(output, 880, 16000)).toBeLessThan(0.02);
  });

  it('rejects rather than folds a tone above the new Nyquist', () => {
    // 10 kHz into a 16 kHz stream would mirror to 6 kHz, right inside the voice
    // band, if the kernel were not also the anti-alias filter.
    const output = new StreamingResampler(48000, 16000).process(sine(10000, 48000, 48000));
    expect(magnitudeAt(output, 6000, 16000)).toBeLessThan(0.05);
    // And the tone itself is gone rather than merely moved.
    expect(magnitudeAt(output, 7000, 16000)).toBeLessThan(0.05);
  });

  it('upsamples back without moving the tone', () => {
    const output = new StreamingResampler(16000, 48000).process(sine(440, 16000, 16000));
    expect(output.length).toBeGreaterThan(47000);
    expect(magnitudeAt(output, 440, 48000)).toBeGreaterThan(0.4);
  });

  it('holds unity gain on DC, so no tone rides on the conversion', () => {
    const input = new Float32Array(4800).fill(0.5);
    const output = new StreamingResampler(48000, 40000).process(input);
    const middle = output.subarray(64, output.length - 64);
    for (const sample of middle) expect(sample).toBeCloseTo(0.5, 4);
  });

  it('produces roughly the expected number of samples', () => {
    const output = new StreamingResampler(48000, 16000).process(new Float32Array(4800));
    expect(output.length).toBeGreaterThan(1590);
    expect(output.length).toBeLessThanOrEqual(1600);
  });

  it('passes audio through untouched when the rates match, allowing for group delay', () => {
    // A linear-phase kernel delays what it passes. That is not an error, but it
    // has to be a *known* quantity, because the dry path is aligned against it.
    const resampler = new StreamingResampler(48000, 48000);
    const input = sine(1000, 48000, 2048);
    const output = resampler.process(input);

    const delay = Math.round(resampler.delaySeconds * 48000);
    expect(delay).toBeGreaterThan(0);
    const compared = Math.min(input.length - delay - 8, output.length - delay);
    for (let i = 8; i < compared; i += 1) expect(output[i + delay]).toBeCloseTo(input[i], 3);
  });

  it('reports a group delay that matches where the signal actually lands', () => {
    // An impulse makes the claim checkable: the peak must sit at the reported delay.
    const resampler = new StreamingResampler(48000, 48000);
    const impulse = new Float32Array(512);
    impulse[64] = 1;
    const output = resampler.process(impulse);

    let peak = 0;
    for (let i = 1; i < output.length; i += 1) {
      if (Math.abs(output[i]) > Math.abs(output[peak])) peak = i;
    }
    expect(peak - 64).toBe(Math.round(resampler.delaySeconds * 48000));
  });

  it('handles an empty chunk without disturbing its phase', () => {
    const resampler = new StreamingResampler(48000, 16000);
    const input = sine(440, 48000, 2400);
    const before = resampler.process(input.subarray(0, 1200));
    expect(resampler.process(new Float32Array(0)).length).toBe(0);
    const after = resampler.process(input.subarray(1200));

    const reference = new StreamingResampler(48000, 16000).process(input);
    const pieced = concat([before, after]);
    const compared = Math.min(reference.length, pieced.length);
    for (let i = 0; i < compared; i += 1) expect(pieced[i]).toBeCloseTo(reference[i], 6);
  });

  it.each([
    [0, 16000],
    [48000, 0],
    [Number.NaN, 16000],
  ])('refuses the nonsense rate pair (%s, %s)', (input, output) => {
    expect(() => new StreamingResampler(input, output)).toThrow(RangeError);
  });
});
