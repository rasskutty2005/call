/**
 * What a voice is, as far as this app is concerned.
 *
 * RVC is not one model. Converting a voice takes a content encoder (HuBERT or
 * ContentVec) that strips speaker identity out of the audio, a pitch track, and
 * a decoder trained on the target voice that puts the two back together. Each is
 * exported separately, and the tensor names differ between export scripts,
 * versions and forks — there is no canonical graph to hard-code against.
 *
 * So the model describes itself. A manifest names the files and the tensors, and
 * this app reads it. Nothing here is guessed from a filename, and a manifest that
 * is wrong is rejected at load with the field named — a mismatched tensor name
 * would otherwise surface as an ONNX runtime error mid-call, which is both too
 * late and unreadable.
 *
 * An example, next to the model files it describes:
 *
 *   {
 *     "version": 1,
 *     "name": "Ava",
 *     "sampleRate": 40000,
 *     "hopLength": 320,
 *     "speakerId": 0,
 *     "contentEncoder": {
 *       "url": "contentvec.onnx",
 *       "sampleRate": 16000,
 *       "input": "source",
 *       "output": "embed",
 *       "featureDim": 768
 *     },
 *     "decoder": {
 *       "url": "net_g.onnx",
 *       "inputs": {
 *         "features": "phone",
 *         "featureLengths": "phone_lengths",
 *         "pitchCoarse": "pitch",
 *         "pitchHz": "pitchf",
 *         "speakerId": "ds"
 *       },
 *       "output": "audio"
 *     }
 *   }
 */

export interface RvcContentEncoder {
  url: string;
  /** What the encoder expects, almost always 16000. Audio is resampled to it. */
  sampleRate: number;
  input: string;
  output: string;
  /** 256 for HuBERT-base "v1" exports, 768 for ContentVec "v2". */
  featureDim: number;
}

export interface RvcDecoder {
  url: string;
  inputs: {
    features: string;
    featureLengths: string;
    pitchCoarse: string;
    pitchHz: string;
    speakerId: string;
  };
  output: string;
}

export interface RvcManifest {
  version: 1;
  name: string;
  /** What the decoder emits. Resampled to the audio context rate on the way out. */
  sampleRate: number;
  hopLength: number;
  speakerId: number;
  contentEncoder: RvcContentEncoder;
  decoder: RvcDecoder;
}

export class RvcManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RvcManifestError';
  }
}

const DECODER_INPUT_KEYS = [
  'features',
  'featureLengths',
  'pitchCoarse',
  'pitchHz',
  'speakerId',
] as const;

/**
 * Validates a parsed manifest, naming the offending field.
 *
 * Strict on purpose. Every check here is a failure that would otherwise happen
 * inside the ONNX runtime, during a call, as a message about a tensor nobody
 * chose the name of.
 */
export function parseManifest(value: unknown): RvcManifest {
  const root = requireObject(value, 'manifest');

  if (root.version !== 1) {
    throw new RvcManifestError(
      `manifest.version must be 1, got ${JSON.stringify(root.version)}.`,
    );
  }

  const encoderRaw = requireObject(root.contentEncoder, 'manifest.contentEncoder');
  const decoderRaw = requireObject(root.decoder, 'manifest.decoder');
  const decoderInputsRaw = requireObject(decoderRaw.inputs, 'manifest.decoder.inputs');

  const contentEncoder: RvcContentEncoder = {
    url: requireString(encoderRaw.url, 'manifest.contentEncoder.url'),
    sampleRate: requirePositiveInt(encoderRaw.sampleRate, 'manifest.contentEncoder.sampleRate'),
    input: requireString(encoderRaw.input, 'manifest.contentEncoder.input'),
    output: requireString(encoderRaw.output, 'manifest.contentEncoder.output'),
    featureDim: requirePositiveInt(encoderRaw.featureDim, 'manifest.contentEncoder.featureDim'),
  };

  const inputs = {} as RvcDecoder['inputs'];
  for (const key of DECODER_INPUT_KEYS) {
    inputs[key] = requireString(decoderInputsRaw[key], `manifest.decoder.inputs.${key}`);
  }

  const manifest: RvcManifest = {
    version: 1,
    name: requireString(root.name, 'manifest.name'),
    sampleRate: requirePositiveInt(root.sampleRate, 'manifest.sampleRate'),
    hopLength: requirePositiveInt(root.hopLength, 'manifest.hopLength'),
    speakerId: requireNonNegativeInt(root.speakerId, 'manifest.speakerId'),
    contentEncoder,
    decoder: {
      url: requireString(decoderRaw.url, 'manifest.decoder.url'),
      inputs,
      output: requireString(decoderRaw.output, 'manifest.decoder.output'),
    },
  };

  // A duplicated tensor name binds one input twice and silently starves another,
  // which produces noise rather than an error.
  const names = DECODER_INPUT_KEYS.map((key) => inputs[key]);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new RvcManifestError(
      `manifest.decoder.inputs maps more than one field to the tensor "${duplicate}".`,
    );
  }

  return manifest;
}

/** Resolves relative model URLs against the manifest's own location. */
export function resolveModelUrls(manifest: RvcManifest, manifestUrl: string): RvcManifest {
  const base = new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost');
  return {
    ...manifest,
    contentEncoder: {
      ...manifest.contentEncoder,
      url: new URL(manifest.contentEncoder.url, base).toString(),
    },
    decoder: { ...manifest.decoder, url: new URL(manifest.decoder.url, base).toString() },
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RvcManifestError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RvcManifestError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new RvcManifestError(`${field} must be a positive integer, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RvcManifestError(
      `${field} must be a non-negative integer, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}
