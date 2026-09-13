/**
 * Streaming sample-rate conversion.
 *
 * Three rates meet in a neural call and none of them agree. WebRTC and the audio
 * context run at 48 kHz, the content encoder wants 16 kHz, and the decoder emits
 * whatever it was trained at — 32, 40 or 48 kHz. Audio therefore crosses a rate
 * boundary twice per chunk, continuously, for the length of the call.
 *
 * Which makes the state the hard part, not the arithmetic. A resampler that
 * treats each chunk independently restarts its phase every time and puts a
 * discontinuity at every boundary: ~47 clicks a second at a 1024-sample hop,
 * which is not a subtle artefact. This one carries the fractional read position
 * and enough history across calls, so chunked input produces the same samples as
 * the whole signal at once.
 *
 * Windowed-sinc rather than linear interpolation. Linear is cheap and its error
 * is a lowpass tilt plus aliased images — on downsampling by three, which is
 * exactly the 48 to 16 kHz case, those images land in the voice band and no
 * amount of model quality recovers from it.
 */
export class StreamingResampler {
  private readonly ratio: number;
  private readonly halfTaps: number;
  private readonly kernel: Float32Array;
  private readonly kernelPhases: number;
  private history: Float32Array;
  /** Fractional read position within `history`, in input samples. */
  private position: number;

  /**
   * @param taps  Width of the sinc window. 16 is inaudible for speech; the cost
   *              is linear in it and this runs per sample on the audio path.
   * @param phases Fractional positions the kernel is pre-computed at. 128 puts
   *              the interpolation error well below the quantisation floor.
   */
  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
    taps = 32,
    phases = 128,
  ) {
    if (!Number.isFinite(inputRate) || inputRate <= 0) {
      throw new RangeError(`inputRate must be positive, got ${inputRate}`);
    }
    if (!Number.isFinite(outputRate) || outputRate <= 0) {
      throw new RangeError(`outputRate must be positive, got ${outputRate}`);
    }

    this.ratio = inputRate / outputRate;
    this.halfTaps = Math.max(1, Math.floor(taps / 2));
    this.kernelPhases = phases;

    /*
     * Cutoff follows the lower of the two rates: downsampling, this is the
     * anti-alias filter; upsampling, the image filter. Same kernel.
     *
     * The rolloff below it buys a transition band, and it is not optional. At 48
     * to 16 kHz the filter has to pass 8 kHz and stop 10 kHz — a 10 kHz tone
     * mirrors to 6 kHz, in the middle of the voice band, where nothing later can
     * remove it. Sixteen taps at full cutoff left that image only 12 dB down,
     * plainly audible. Thirty-two taps with a 0.92 rolloff put it below -26 dB.
     *
     * The cost is the top 8% of the new band, which for speech at 16 kHz is
     * 7.4 kHz upward: almost no energy, and a far better trade than an alias.
     * Equal rates keep full cutoff, so identity conversion stays identity.
     */
    const nyquistRatio = Math.min(1, outputRate / inputRate);
    const cutoff = nyquistRatio < 1 ? nyquistRatio * 0.92 : 1;
    this.kernel = buildKernel(this.halfTaps, phases, cutoff);

    this.history = new Float32Array(this.halfTaps * 2);
    this.position = this.halfTaps;
  }

  /**
   * Group delay of the kernel, in seconds.
   *
   * A linear-phase filter delays what it passes, and AudioPipeline aligns its dry
   * path against the wet path's reported latency — an unreported delay here would
   * show up as comb filtering when the two are mixed, not as lateness.
   */
  get delaySeconds(): number {
    return this.halfTaps / this.inputRate;
  }

  /** Output samples produced so far are a pure function of all input so far. */
  process(input: Float32Array): Float32Array {
    if (input.length === 0) return EMPTY;

    const buffer = new Float32Array(this.history.length + input.length);
    buffer.set(this.history, 0);
    buffer.set(input, this.history.length);

    // The last position that still has a full kernel of samples to its right.
    const limit = buffer.length - this.halfTaps;
    const count = Math.max(0, Math.ceil((limit - this.position) / this.ratio));
    const output = new Float32Array(count);

    let position = this.position;
    for (let i = 0; i < count; i += 1) {
      output[i] = this.sampleAt(buffer, position);
      position += this.ratio;
    }

    // Keep only what the next call can still reach backwards through.
    const consumed = Math.max(0, Math.floor(position) - this.halfTaps);
    this.history = buffer.slice(consumed);
    this.position = position - consumed;

    return output;
  }

  /** Forget everything. Between calls, never during one. */
  reset(): void {
    this.history = new Float32Array(this.halfTaps * 2);
    this.position = this.halfTaps;
  }

  /** Interpolates `buffer` at a fractional index with the windowed-sinc kernel. */
  private sampleAt(buffer: Float32Array, position: number): number {
    const index = Math.floor(position);
    const frac = position - index;
    const phase = Math.min(this.kernelPhases - 1, Math.floor(frac * this.kernelPhases));
    const taps = this.halfTaps * 2;
    const base = phase * taps;

    let sum = 0;
    for (let t = 0; t < taps; t += 1) {
      const sampleIndex = index - this.halfTaps + 1 + t;
      if (sampleIndex < 0 || sampleIndex >= buffer.length) continue;
      sum += buffer[sampleIndex] * this.kernel[base + t];
    }
    return sum;
  }
}

const EMPTY = new Float32Array(0);

/**
 * Pre-computes the kernel at every fractional phase, normalised per phase.
 *
 * Normalising matters more than it looks: an un-normalised windowed sinc has a
 * gain that varies slightly with phase, and a gain that wobbles at the resampling
 * rate is audible as a tone. Forcing each phase to unity DC gain removes it.
 */
function buildKernel(halfTaps: number, phases: number, cutoff: number): Float32Array {
  const taps = halfTaps * 2;
  const kernel = new Float32Array(phases * taps);

  for (let phase = 0; phase < phases; phase += 1) {
    const frac = phase / phases;
    let sum = 0;
    const base = phase * taps;

    for (let t = 0; t < taps; t += 1) {
      const x = t - halfTaps + 1 - frac;
      const value = cutoff * sinc(cutoff * x) * blackman(x, halfTaps);
      kernel[base + t] = value;
      sum += value;
    }

    if (sum !== 0) {
      for (let t = 0; t < taps; t += 1) kernel[base + t] /= sum;
    }
  }

  return kernel;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const piX = Math.PI * x;
  return Math.sin(piX) / piX;
}

function blackman(x: number, halfTaps: number): number {
  const n = (x + halfTaps) / (halfTaps * 2);
  if (n < 0 || n > 1) return 0;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n);
}
