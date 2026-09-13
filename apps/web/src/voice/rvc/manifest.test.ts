/**
 * Every rejection here is a failure that would otherwise surface inside the ONNX
 * runtime, mid-call, as a message about a tensor name nobody in this codebase
 * chose. The point of the manifest is to move those failures to load time and
 * give them the name of the field that is wrong.
 */
import { describe, expect, it } from 'vitest';
import { parseManifest, resolveModelUrls, RvcManifestError } from './manifest';

const valid = {
  version: 1,
  name: 'Ava',
  sampleRate: 40000,
  hopLength: 320,
  speakerId: 0,
  contentEncoder: {
    url: 'contentvec.onnx',
    sampleRate: 16000,
    input: 'source',
    output: 'embed',
    featureDim: 768,
  },
  decoder: {
    url: 'net_g.onnx',
    inputs: {
      features: 'phone',
      featureLengths: 'phone_lengths',
      pitchCoarse: 'pitch',
      pitchHz: 'pitchf',
      speakerId: 'ds',
    },
    output: 'audio',
  },
};

const withDecoderInputs = (inputs: Record<string, unknown>) => ({
  ...valid,
  decoder: { ...valid.decoder, inputs },
});

describe('parseManifest', () => {
  it('accepts a complete manifest', () => {
    expect(parseManifest(structuredClone(valid))).toMatchObject({
      name: 'Ava',
      sampleRate: 40000,
      contentEncoder: { featureDim: 768 },
      decoder: { inputs: { pitchHz: 'pitchf' } },
    });
  });

  it('accepts speakerId 0, which is the common case and is falsy', () => {
    expect(parseManifest({ ...structuredClone(valid), speakerId: 0 }).speakerId).toBe(0);
  });

  it.each([
    ['name', { name: '' }],
    ['sampleRate', { sampleRate: 0 }],
    ['hopLength', { hopLength: -320 }],
    ['speakerId', { speakerId: -1 }],
  ])('rejects a bad %s and names the field', (field, override) => {
    expect(() => parseManifest({ ...structuredClone(valid), ...override })).toThrow(
      new RegExp(`manifest\.${field}`),
    );
  });

  it('rejects a non-integer sample rate rather than rounding it', () => {
    expect(() => parseManifest({ ...structuredClone(valid), sampleRate: 40000.5 })).toThrow(
      RvcManifestError,
    );
  });

  it('names the missing decoder input, not just "invalid manifest"', () => {
    const inputs = { ...valid.decoder.inputs } as Record<string, unknown>;
    delete inputs.pitchHz;
    expect(() => parseManifest(withDecoderInputs(inputs))).toThrow(
      /manifest\.decoder\.inputs\.pitchHz/,
    );
  });

  it('rejects two fields bound to the same tensor', () => {
    // This one is worth catching: it binds one input twice and starves another,
    // so the model runs and produces noise instead of failing.
    const inputs = { ...valid.decoder.inputs, pitchHz: 'pitch' };
    expect(() => parseManifest(withDecoderInputs(inputs))).toThrow(/more than one field/);
  });

  it('rejects a future manifest version instead of guessing at it', () => {
    expect(() => parseManifest({ ...structuredClone(valid), version: 2 })).toThrow(
      /manifest\.version must be 1/,
    );
  });

  it.each([null, undefined, 42, 'manifest', []])('rejects %s as a manifest', (value) => {
    expect(() => parseManifest(value)).toThrow(RvcManifestError);
  });
});

describe('resolveModelUrls', () => {
  it('resolves model paths against the manifest, not the page', () => {
    const resolved = resolveModelUrls(
      parseManifest(structuredClone(valid)),
      'https://cdn.example.com/voices/ava/manifest.json',
    );
    expect(resolved.contentEncoder.url).toBe('https://cdn.example.com/voices/ava/contentvec.onnx');
    expect(resolved.decoder.url).toBe('https://cdn.example.com/voices/ava/net_g.onnx');
  });

  it('leaves an absolute model URL alone, so models can live off the manifest host', () => {
    const manifest = parseManifest({
      ...structuredClone(valid),
      decoder: { ...valid.decoder, url: 'https://models.example.org/net_g.onnx' },
    });
    expect(resolveModelUrls(manifest, 'https://cdn.example.com/v/manifest.json').decoder.url).toBe(
      'https://models.example.org/net_g.onnx',
    );
  });
});
