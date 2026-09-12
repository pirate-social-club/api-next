#!/usr/bin/env node
// Prepares a playback-only local API overlay for the resume verification:
// uploads stay disabled, so no remote R2 binding session is needed, while
// signed playback, the rate limiter and the local database remain real.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";

const config = JSON.parse(readFileSync(resolve(here, "wrangler.local-e2e.json"), "utf8"));
config.main = resolve(root, "apps", "http-worker", "src", "index.ts");
config.r2_buckets = (config.r2_buckets ?? []).map((entry) =>
  entry.binding === "MEDIA_INGRESS" || entry.binding === "MEDIA_IMMUTABLE_ORIGINALS"
    ? { ...entry, remote: false }
    : entry,
);
config.vars = {
  ...config.vars,
  MEDIA_UPLOADS_ENABLED: "false",
  SONG_PLAYBACK_ENABLED: "true",
  SONG_PLAYBACK_R2_ACCOUNT_ID: ACCOUNT_ID,
  SONG_PLAYBACK_R2_BUCKET: "pirate-media-immutable-staging",
};
writeFileSync(resolve(here, "wrangler.resume-e2e.json"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${resolve(here, "wrangler.resume-e2e.json")}`);
