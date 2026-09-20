/**
 * Local playback media for the Study/Karaoke harness.
 *
 * The browser feed plays real video through the real playback path: the
 * harness Worker mints a Stream-shaped grant, Chromium maps the customer host
 * to this loopback TLS server, and the server answers with HLS generated
 * locally by ffmpeg. No provider, credential or network request is involved.
 *
 * Run from start-local.sh; stop with stop-local.sh or SIGTERM.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const mediaDirectory = path.join(scriptDirectory, ".local", "media");
const certificatePath = path.join(mediaDirectory, "cert.pem");
const keyPath = path.join(mediaDirectory, "key.pem");
const playlistPath = path.join(mediaDirectory, "master.m3u8");
const posterPath = path.join(mediaDirectory, "poster.jpg");
const customerHost = "customer-harness.cloudflarestream.com";
const port = Number(process.env.HARNESS_MEDIA_PORT ?? "8443");

mkdirSync(mediaDirectory, { recursive: true });

function run(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], { stdio: "inherit" });
}

if (!existsSync(playlistPath)) {
  console.log("generating local HLS fixture with ffmpeg");
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_filename",
    path.join(mediaDirectory, "seg_%03d.ts"),
    playlistPath,
  ]);
}

if (!existsSync(posterPath)) {
  run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=1",
    "-frames:v",
    "1",
    "-q:v",
    "6",
    posterPath,
  ]);
}

if (!existsSync(certificatePath) || !existsSync(keyPath)) {
  console.log("generating the local playback certificate");
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "2",
    "-subj",
    `/CN=${customerHost}`,
    "-addext",
    `subjectAltName=DNS:${customerHost}`,
  ]);
}

const contentType = (name: string): string =>
  name.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : name.endsWith(".ts")
      ? "video/mp2t"
      : "image/jpeg";

const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
  (request, response) => {
    // hls.js fetches the playlist and segments with XHR from the app origin.
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "*",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    const name = path.basename(pathname);
    // The signed grant path is /<token>/<token>/manifest/video.m3u8; the
    // segment names are resolved relative to that directory.
    const resolved = name === "video.m3u8" ? "master.m3u8" : name;
    if (!/^[A-Za-z0-9_.-]+$/u.test(resolved)) {
      response.writeHead(404).end();
      return;
    }
    void readFile(path.join(mediaDirectory, resolved))
      .then((bytes) => {
        response.writeHead(200, {
          ...cors,
          "content-type": contentType(resolved),
          "cache-control": "no-store",
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(404).end();
      });
  },
);

server.listen(port, "127.0.0.1", () => {
  console.log(`harness playback media ready at https://${customerHost} -> 127.0.0.1:${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
