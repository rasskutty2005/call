/**
 * Which part of the phone a call comes out of.
 *
 * A web page cannot pick the earpiece the way a native app can. `setSinkId()`
 * enumerates real output devices, and on a phone the earpiece is not one of
 * them — so a call played through an <audio> element goes to the loudspeaker.
 * That is the right default for a video, and the wrong one for something you
 * hold against your head in a room with other people in it.
 *
 * The Audio Session API is the only lever that exists from here. It does not
 * name an output; it states what kind of audio this is, and lets the OS route
 * accordingly:
 *
 *   play-and-record — a call. iOS routes it to the receiver (the earpiece).
 *   playback        — media. The loudspeaker.
 *
 * Safari 17 and later implement it. Chrome on Android does not, and has no
 * equivalent: WebRTC audio there plays as media and reaches the loudspeaker
 * whatever the page does. So `isRoutingSupported()` answers honestly and the UI
 * leaves out a control it cannot honour, rather than offering a button that
 * silently does nothing.
 */

type AudioSessionType =
  | 'auto'
  | 'playback'
  | 'transient'
  | 'transient-solo'
  | 'ambient'
  | 'play-and-record';

interface AudioSession {
  type: AudioSessionType;
}

export type CallAudioRoute = 'earpiece' | 'speaker';

function audioSession(): AudioSession | null {
  if (typeof navigator === 'undefined') return null;
  const withSession = navigator as Navigator & { audioSession?: AudioSession };
  return withSession.audioSession ?? null;
}

/** Whether this browser lets a page influence call routing at all. */
export function isRoutingSupported(): boolean {
  return audioSession() !== null;
}

/**
 * Returns whether the request was actually made, not whether the OS honoured it
 * — nothing reports the chosen output back, and a connected headset or car
 * outranks anything asked for here, correctly.
 */
export function setCallAudioRoute(route: CallAudioRoute): boolean {
  const session = audioSession();
  if (!session) return false;
  try {
    session.type = route === 'earpiece' ? 'play-and-record' : 'playback';
    return true;
  } catch {
    return false;
  }
}

/** Hand the session back after a call, so ordinary media is not treated as one. */
export function releaseCallAudioRoute(): void {
  const session = audioSession();
  if (!session) return;
  try {
    session.type = 'auto';
  } catch {
    // Nothing to restore, and nothing worth failing a teardown over.
  }
}
