import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import {
  initializeKaraokeMicrophone,
  installKaraokeMicrophone,
} from "./browser-karaoke-microphone.mjs";

function browser(origin = "https://isolated.test", decodeFails = false) {
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const starts: number[][] = [];
  let stopped = 0;
  let closed = 0;
  let nativeCalls = 0;
  let clock = 0;
  const track = {
    stop: () => {
      stopped += 1;
    },
  };
  class AudioElement {
    src = "https://isolated.test/backing.wav";
    currentTime = 0;
  }
  class Context {
    get currentTime() {
      return clock;
    }
    async resume() {}
    async close() {
      closed += 1;
    }
    async decodeAudioData() {
      if (decodeFails) throw Error("Decoder refused fixture");
      return {};
    }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [track] } };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        disconnect() {},
        stop() {
          stopped += 1;
        },
        start: (...args: number[]) => {
          starts.push(args);
        },
      };
    }
  }
  const mediaDevices = {
    getUserMedia: async (_constraints?: unknown) => {
      nativeCalls += 1;
      return "native";
    },
  };
  const environment = {
    location: { origin },
    navigator: { mediaDevices },
    AudioContext: Context,
    HTMLAudioElement: AudioElement,
    document: {
      addEventListener: (kind: string, callback: (event: { target: unknown }) => void) => {
        listeners.set(kind, callback);
      },
      removeEventListener: (kind: string) => {
        listeners.delete(kind);
      },
    },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
  };
  runInNewContext(`(${initializeKaraokeMicrophone.toString()})(input)`, {
    ...environment,
    input: {
      origin: "https://isolated.test",
      fixtureUrl: "https://isolated.test/mic.wav",
      offsetSeconds: 2.8,
    },
  });
  const player = new AudioElement();
  return {
    mediaDevices,
    player,
    starts,
    track,
    listeners,
    setClock: (value: number) => {
      clock = value;
    },
    event: (kind: string) => listeners.get(kind)?.({ target: player }),
    counts: () => ({ stopped, closed, nativeCalls }),
  };
}

test("setup delay consumes no microphone audio; actual playback chooses the start", async () => {
  const b = browser();
  await b.mediaDevices.getUserMedia({ audio: true });
  expect(b.starts).toEqual([]);
  b.setClock(15);
  expect(b.starts).toEqual([]);
  b.event("playing");
  expect(b.starts).toEqual([[15, 2.8]]);
});

test("pause and buffering stop speech; playback resume uses the current song position", async () => {
  const b = browser();
  await b.mediaDevices.getUserMedia({ audio: true });
  b.event("playing");
  b.event("pause");
  b.player.currentTime = 20;
  b.setClock(35);
  b.event("playing");
  expect(b.starts.at(-1)).toEqual([35, 22.8]);
  b.event("waiting");
  expect(b.counts().stopped).toBe(2);
  b.track.stop();
  expect(b.listeners.size).toBe(0);
  b.event("playing");
  expect(b.starts).toHaveLength(2);
  expect(b.counts().closed).toBe(1);
});

test("a failed decoder closes its context and refuses the microphone", async () => {
  const b = browser("https://isolated.test", true);
  await expect(b.mediaDevices.getUserMedia({ audio: true })).rejects.toThrow(
    "Decoder refused fixture",
  );
  expect(b.counts().closed).toBe(1);
  expect(b.starts).toHaveLength(0);
});

test("another origin keeps its native microphone", async () => {
  const b = browser("https://another.test");
  expect(await b.mediaDevices.getUserMedia({ audio: true })).toBe("native");
  expect(b.counts().nativeCalls).toBe(1);
  expect(b.listeners.size).toBe(0);
});

test("an unavailable accepted recording is refused before installing a route or script", async () => {
  let installed = false;
  const context = {
    route: async () => {
      installed = true;
    },
    addInitScript: async () => {
      installed = true;
    },
  };
  await expect(installKaraokeMicrophone(context, "/missing/rewards-fixture.wav")).rejects.toThrow(
    "not readable",
  );
  expect(installed).toBe(false);
});
