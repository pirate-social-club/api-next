import { readFixtureMicrophone } from "./fixture-microphone.mjs";
import { karaokeCountInMs } from "./karaoke-speech-fixture.mjs";
import { isolatedOrigins } from "./worker-plan.mjs";

/** A test microphone carrying the accepted WAV, aligned to actual song playback. */
export async function installKaraokeMicrophone(context, fixturePath) {
  const fixture = readFixtureMicrophone("karaoke", fixturePath);
  const fixtureUrl = new URL("/__rewards_e2e_microphone.wav", isolatedOrigins.web).href;
  await context.route(fixtureUrl, (route) =>
    route.fulfill({ status: 200, contentType: "audio/wav", path: fixture.path }),
  );
  await context.addInitScript(initializeKaraokeMicrophone, {
    fixtureUrl,
    origin: isolatedOrigins.web,
    offsetSeconds: karaokeCountInMs / 1000,
  });
}

export function initializeKaraokeMicrophone({ fixtureUrl, origin, offsetSeconds }) {
  if (location.origin !== origin || !navigator.mediaDevices) return;
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let installed = false;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.audio || constraints?.video) return original(constraints);
    if (installed) throw Error("Only one Karaoke microphone is allowed per document");
    installed = true;
    const context = new AudioContext({ sampleRate: 48000 });
    let buffer;
    try {
      await context.resume();
      const response = await fetch(fixtureUrl);
      if (!response.ok) throw Error("Microphone fixture unavailable");
      buffer = await context.decodeAudioData(await response.arrayBuffer());
    } catch (error) {
      await context.close();
      throw error;
    }
    const destination = context.createMediaStreamDestination();
    let source;
    let player;
    let stopped = false;
    const stopSource = () => {
      if (!source) return;
      source.stop();
      source.disconnect();
      source = undefined;
    };
    const play = (event) => {
      const media = event.target;
      if (stopped || !(media instanceof HTMLAudioElement) || !media.src) return;
      if (player && player !== media) return;
      player = media;
      stopSource();
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      // Remove the old fixed count-in padding. Session setup may take any time;
      // speech starts only once the backing audio actually plays.
      source.start(context.currentTime, offsetSeconds + media.currentTime);
    };
    const pause = (event) => {
      if (event.target === player) stopSource();
    };
    document.addEventListener("playing", play, true);
    document.addEventListener("pause", pause, true);
    document.addEventListener("waiting", pause, true);
    const track = destination.stream.getAudioTracks()[0];
    const stopTrack = track.stop.bind(track);
    track.stop = () => {
      stopped = true;
      stopSource();
      document.removeEventListener("playing", play, true);
      document.removeEventListener("pause", pause, true);
      document.removeEventListener("waiting", pause, true);
      stopTrack();
      void context.close();
    };
    return destination.stream;
  };
}
