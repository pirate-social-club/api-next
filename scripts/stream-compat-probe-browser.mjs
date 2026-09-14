/**
 * Browser half of `stream-compat-probe.ts`, run under Node because Playwright's
 * browser pipe is not reliable under Bun. Headless Chromium plays an HLS
 * manifest through hls.js with sound, as the web player does, and prints one
 * JSON line of what it observed. Frames are read at their own media time;
 * audio is read through Web Audio while playing, so click times are coarse
 * (one analyser window, about 43 ms). This is desktop browser playback only.
 *
 * Inputs come from the environment so a signed URL never appears in argv:
 *   PROBE_MANIFEST_URL, PROBE_PAGE_ORIGIN, PLAYWRIGHT_MODULE, HLS_JS_PATH, and
 *   PROBE_LOCAL_DELIVERY=1 for the offline rehearsal only.
 * Errors are reported with every URL removed.
 */
import { readFile } from "node:fs/promises";

const manifest = process.env.PROBE_MANIFEST_URL ?? "";
const origin = process.env.PROBE_PAGE_ORIGIN ?? "";
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "";
const hlsPath = process.env.HLS_JS_PATH ?? "";
if (!manifest || !origin || !playwrightModule || !hlsPath) {
  console.log(JSON.stringify({ played: false, reason: "browser inputs missing" }));
  process.exit(2);
}

const { chromium } = await import(playwrightModule);
const hlsSource = await readFile(hlsPath, "utf8");
// The rehearsal serves its HLS on loopback, which Chromium's local network
// access rules refuse to a page from another address space. Only that case
// lifts them; a live run fetches Stream's public delivery under the normal rules.
const localDelivery = process.env.PROBE_LOCAL_DELIVERY === "1";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    ...(localDelivery
      ? [
          "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
        ]
      : []),
  ],
});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", () => consoleErrors.push("page error"));
  // A page origin of our own, so the delivery's cross-origin rules apply as
  // they would on the site.
  await page.route(origin, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: '<!doctype html><html><body><video id="v" playsinline></video></body></html>',
    }),
  );
  await page.goto(origin);
  await page.addScriptTag({ content: hlsSource });
  const observed = await page.evaluate(async (url) => {
    const element = document.getElementById("v");
    const Hls = window.Hls;
    const hls = new Hls({ enableWorker: false });
    const failures = [];
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) failures.push(`${data.type}:${data.details}`);
    });
    const parsed = new Promise((resolve) =>
      hls.on(Hls.Events.MANIFEST_PARSED, () => resolve(true)),
    );
    hls.loadSource(url);
    hls.attachMedia(element);
    const manifestParsed = await Promise.race([
      parsed,
      new Promise((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    // Playing a media source that never received a manifest takes the
    // headless browser down, which would hide the reason; stop here instead.
    if (!manifestParsed) return { failures, manifestParsed, ended: false, playError: null };
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2_048;
    context.createMediaElementSource(element).connect(analyser);
    analyser.connect(context.destination);
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const graphics = canvas.getContext("2d", { willReadFrequently: true });
    const frames = [];
    const onFrame = (_now, meta) => {
      graphics.drawImage(element, 0, 0, 8, 8);
      const pixels = graphics.getImageData(0, 0, 8, 8).data;
      let sum = 0;
      for (let index = 0; index < pixels.length; index += 4) sum += pixels[index];
      frames.push({ mediaTime: meta.mediaTime, luma: sum / 64 });
      element.requestVideoFrameCallback(onFrame);
    };
    element.requestVideoFrameCallback(onFrame);
    const buffer = new Float32Array(analyser.fftSize);
    const audio = [];
    const poll = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let peak = 0;
      for (const value of buffer) peak = Math.max(peak, Math.abs(value));
      audio.push({ time: element.currentTime, peak });
    }, 5);
    await context.resume();
    let playError = null;
    await element.play().catch((error) => {
      playError = String(error);
    });
    await Promise.race([
      new Promise((resolve) => element.addEventListener("ended", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 30_000)),
    ]);
    clearInterval(poll);
    const quality = element.getVideoPlaybackQuality();
    return {
      failures,
      manifestParsed,
      playError,
      ended: element.ended,
      duration: element.duration,
      currentTime: element.currentTime,
      totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames,
      audioDecodedBytes: element.webkitAudioDecodedByteCount ?? null,
      videoDecodedBytes: element.webkitVideoDecodedByteCount ?? null,
      audioTracks: hls.audioTracks.length,
      levels: hls.levels.length,
      flashMediaTimes: frames.filter((frame) => frame.luma > 230).map((frame) => frame.mediaTime),
      framesSeen: frames.length,
      loudestPeak: audio.reduce((max, sample) => Math.max(max, sample.peak), 0),
      clickTimes: audio
        .filter((sample, index) => sample.peak > 0.5 && (audio[index - 1]?.peak ?? 0) <= 0.5)
        .map((sample) => sample.time),
    };
  }, manifest);
  console.log(
    JSON.stringify({
      played: observed.ended && observed.failures.length === 0 && observed.playError === null,
      browser: `headless Chromium ${browser.version()} with hls.js`,
      pageErrors: consoleErrors.length,
      ...observed,
    }),
  );
} catch (error) {
  // The detail is kept for diagnosis with every URL removed from it.
  const detail = String(error instanceof Error ? error.message : error)
    .replaceAll(/https?:\/\/\S+/gu, "<url>")
    .slice(0, 400);
  console.log(JSON.stringify({ played: false, reason: "browser playback failed", detail }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
