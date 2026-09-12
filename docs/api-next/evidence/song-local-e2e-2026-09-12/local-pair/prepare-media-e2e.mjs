#!/usr/bin/env node
// Prepares the local API configuration for the full song onboarding journey.
// Writes only ignored files; prints key names and paths, never values.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const workerDir = resolve(root, "apps", "http-worker");
const devVarsPath = resolve(workerDir, ".dev.vars");
const localDevVars = resolve(here, ".dev.vars");
const overlayPath = resolve(here, "wrangler.local-e2e.json");

const ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";
const INGRESS_BUCKET = "pirate-media-ingress-staging";
const IMMUTABLE_BUCKET = "pirate-media-immutable-staging";
const PLAYBACK_SECRET_NAMES = [
  "MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID",
  "MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY",
  "SONG_PLAYBACK_R2_ACCESS_KEY_ID",
  "SONG_PLAYBACK_R2_SECRET_ACCESS_KEY",
  "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
];

function stripJsonc(text) {
  let out = "";
  let inString = false;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseDevVars(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    env[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return env;
}

function serializeValue(value) {
  return JSON.stringify(value);
}

const config = JSON.parse(stripJsonc(readFileSync(resolve(workerDir, "wrangler.jsonc"), "utf8")));
config.main = resolve(workerDir, "src", "index.ts");
config.r2_buckets = [
  ...(config.r2_buckets ?? []).filter(
    (entry) => entry.binding !== "MEDIA_INGRESS" && entry.binding !== "MEDIA_IMMUTABLE_ORIGINALS",
  ),
  { binding: "MEDIA_INGRESS", bucket_name: INGRESS_BUCKET, remote: true },
  { binding: "MEDIA_IMMUTABLE_ORIGINALS", bucket_name: IMMUTABLE_BUCKET, remote: true },
];
config.vars = {
  ...config.vars,
  MEDIA_UPLOADS_ENABLED: "true",
  MEDIA_INGRESS_R2_ACCOUNT_ID: ACCOUNT_ID,
  MEDIA_INGRESS_R2_BUCKET_NAME: INGRESS_BUCKET,
  SONG_PLAYBACK_ENABLED: "true",
  SONG_PLAYBACK_R2_ACCOUNT_ID: ACCOUNT_ID,
  SONG_PLAYBACK_R2_BUCKET: IMMUTABLE_BUCKET,
};
const required = new Set(config.secrets?.required ?? []);
for (const name of PLAYBACK_SECRET_NAMES) required.add(name);
config.secrets = { ...(config.secrets ?? {}), required: [...required] };
writeFileSync(overlayPath, `${JSON.stringify(config, null, 2)}\n`);

if (!existsSync(localDevVars)) {
  symlinkSync("../../apps/http-worker/.dev.vars", localDevVars);
}

const devVars = parseDevVars(readFileSync(devVarsPath, "utf8"));
const accessKeyId = devVars.MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID;
const secretAccessKey = devVars.MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  throw new Error("Ingress presign credentials are absent from apps/http-worker/.dev.vars");
}
const updates = new Map();
updates.set("MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID", accessKeyId);
updates.set("MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY", secretAccessKey);
updates.set("SONG_PLAYBACK_R2_ACCESS_KEY_ID", accessKeyId);
updates.set("SONG_PLAYBACK_R2_SECRET_ACCESS_KEY", secretAccessKey);
updates.set(
  "SONG_PLAYBACK_SOURCE_HMAC_BASE64",
  devVars.SONG_PLAYBACK_SOURCE_HMAC_BASE64 ?? randomBytes(32).toString("base64"),
);
const lines = readFileSync(devVarsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "" && !updates.has(/^([A-Za-z0-9_]+)=/.exec(line)?.[1] ?? ""));
for (const [key, value] of updates) lines.push(`${key}=${serializeValue(value)}`);
writeFileSync(devVarsPath, `${lines.join("\n")}\n`, { mode: 0o600 });

console.log(`overlay: ${overlayPath}`);
console.log(`dev.vars symlink: ${localDevVars}`);
console.log(`dev.vars updated keys: ${[...updates.keys()].join(", ")}`);
console.log("shared values are never printed; local playback reuses the ingress credential only.");
