/**
 * Regression cover for a call that connects to nothing and never says so.
 *
 * `negotiationneeded` fires once per flag set. The handlers here were assigned
 * after `addTrack` and after an `await`, so the event could be dispatched at a
 * connection with no listener and vanish. Only the caller offers — the callee
 * starts with negotiation suppressed — so that one lost event meant no offer was
 * ever made: nothing threw, ICE never failed because it never started, and both
 * peers sat on "connecting" indefinitely. It came down to how quickly
 * setParameters resolved, which is why it varied by device.
 *
 * There is no browser here, so this stubs the two things connect() touches and
 * asserts the two properties that matter: listeners exist before the flag is
 * set, and an offer goes out even if the event never arrives at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipelineTrack = { kind: 'audio' } as MediaStreamTrack;
const pipelineStream = {} as MediaStream;

vi.mock('@/voice/AudioPipeline', () => ({
  AudioPipeline: class {
    isStarted = true;
    outboundTrack = pipelineTrack;
    outboundStream = pipelineStream;
    isVoiceChangerEnabled = false;
    preset = null;
    async start() {}
    async stop() {}
  },
}));

/** Records what was true at the moment each step ran. */
class FakePeerConnection {
  static last: FakePeerConnection | null = null;
  static listenerAtAddTrack: boolean | null = null;

  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((event: unknown) => void) | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  signalingState = 'stable';
  connectionState = 'new';
  localDescription: (RTCSessionDescriptionInit & { toJSON(): RTCSessionDescriptionInit }) | null = null;

  constructor() {
    FakePeerConnection.last = this;
  }

  addTrack() {
    // The flag is set here; a listener must already be attached.
    FakePeerConnection.listenerAtAddTrack = this.onnegotiationneeded !== null;
    return {};
  }

  getSenders() {
    return [
      {
        getParameters: () => ({ encodings: [{}] }),
        // Resolving on a later task is what used to lose the event.
        setParameters: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      },
    ];
  }

  async setLocalDescription() {
    // toJSON() included: the production code calls it, and a stub without it
    // throws into the catch and looks exactly like "no offer was sent".
    const description: RTCSessionDescriptionInit = { type: 'offer', sdp: 'v=0' };
    this.localDescription = { ...description, toJSON: () => description };
    this.signalingState = 'have-local-offer';
  }

  async getStats() {
    return new Map();
  }

  close() {}
}

describe('CallSession.connect', () => {
  beforeEach(() => {
    FakePeerConnection.last = null;
    FakePeerConnection.listenerAtAddTrack = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('MediaStream', class {});
  });

  async function connectAsCaller() {
    const { CallSession } = await import('./CallSession');
    const sendOffer = vi.fn();
    const session = new CallSession(
      { callId: 'call-1', role: 'caller' },
      {
        sendOffer,
        sendAnswer: vi.fn(),
        sendIceCandidate: vi.fn(),
        onConnected: vi.fn(),
        onReconnecting: vi.fn(),
        onFailed: vi.fn(),
        onQuality: vi.fn(),
        onError: vi.fn(),
        onAudioBlocked: vi.fn(),
      },
    );
    await session.connect({ iceServers: [], ttl: 0, hasTurn: false });
    return { session, sendOffer };
  }

  it('attaches negotiationneeded before addTrack sets the flag', async () => {
    const { session } = await connectAsCaller();
    expect(FakePeerConnection.listenerAtAddTrack).toBe(true);
    await session.close();
  });

  it('still sends an offer when negotiationneeded never fires', async () => {
    // The fake never dispatches the event, which is the failure being guarded.
    const { session, sendOffer } = await connectAsCaller();
    expect(sendOffer).toHaveBeenCalledTimes(1);
    expect(sendOffer.mock.calls[0][0]).toMatchObject({ type: 'offer' });
    await session.close();
  });
});
