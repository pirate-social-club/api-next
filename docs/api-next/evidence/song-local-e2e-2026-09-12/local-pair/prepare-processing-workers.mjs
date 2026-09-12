#!/usr/bin/env node
// Prepares local overlay configs for the jobs worker (outbox/queue dispatch)
// and the media processor worker (queue consumer + MediaProcessingWorkflow).
// Writes only ignored files under .tmp/local-pair.
import { mkdirSync, readFileSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";

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

function load(relativePath) {
  return JSON.parse(stripJsonc(readFileSync(resolve(root, relativePath), "utf8")));
}

function write(relativeDir, config) {
  const dir = resolve(here, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

const jobs = load("apps/jobs-worker/wrangler.jsonc");
const jobsDir = write("jobs", jobs);
const jobsEntry = resolve(jobsDir, "entrypoint.ts");
writeFileSync(
  jobsEntry,
  [
    'import worker from "../../../apps/jobs-worker/src/index.ts";',
    'export { ScheduledCronLockDO } from "../../../apps/jobs-worker/src/index.ts";',
    "export default worker;",
    "",
  ].join("\n"),
);
jobs.main = jobsEntry;
jobs.vars = { ...jobs.vars, MEDIA_PROCESSING_ENABLED: "true" };
write("jobs", jobs);

const processor = load("apps/media-processor-worker/wrangler.jsonc");
processor.main = resolve(root, "apps", "media-processor-worker", "src", "entrypoint.ts");
processor.vars = {
  ...processor.vars,
  MEDIA_PROCESSING_ENABLED: "true",
  ACRCLOUD_IDENTIFY_HOST: "identify-eu-west-1.acrcloud.com",
};
processor.r2_buckets = (processor.r2_buckets ?? []).map((entry) =>
  entry.binding === "MEDIA_IMMUTABLE_ORIGINALS"
    ? { ...entry, bucket_name: "pirate-media-immutable-staging", remote: true }
    : entry.binding === "MEDIA_DERIVED_ARTIFACTS"
      ? { ...entry, bucket_name: "pirate-media-derived-staging", remote: true }
      : entry,
);
const required = new Set(processor.secrets?.required ?? []);
required.add("OPENROUTER_API_KEY");
processor.secrets = { ...(processor.secrets ?? {}), required: [...required] };
const processorDir = write("media-processor", processor);
const processorEntry = resolve(processorDir, "entrypoint.ts");
writeFileSync(
  processorEntry,
  `// Local budget guard for the fixture journey. Counts billable provider
// requests, logs each one as JSON, and refuses any request over the hard cap.
// The caps allow one retry per provider stage and stop the workflow with
// evidence instead of spending beyond the authorized budget.
const budgets = {
  "acrcloud.com": 2,
  "api.openai.com": 3,
  "openrouter.ai": 1,
  "api.elevenlabs.io": 1,
};
const counts = {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let host = "";
  try {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    host = url.hostname;
  } catch {
    host = "";
  }
  const provider = Object.keys(budgets).find(
    (suffix) => host === suffix || host.endsWith(\`.\${suffix}\`),
  );
  if (provider !== undefined) {
    counts[provider] = (counts[provider] ?? 0) + 1;
    console.log(JSON.stringify({
      event: "provider-request",
      provider,
      host,
      count: counts[provider],
      budget: budgets[provider],
    }));
    if (counts[provider] > budgets[provider]) {
      console.log(JSON.stringify({
        event: "provider-budget-exhausted",
        provider,
        count: counts[provider],
        budget: budgets[provider],
      }));
      throw new Error(\`provider budget exhausted: \${provider}\`);
    }
  }
  return originalFetch(input, init);
};
const entry = await import("../../../apps/media-processor-worker/src/entrypoint.ts");
export default entry.default;
export const MediaProcessingWorkflow = entry.MediaProcessingWorkflow;
export const DanceReferenceProcessingWorkflow = entry.DanceReferenceProcessingWorkflow;
export const VideoAnalysisWorkflow = entry.VideoAnalysisWorkflow;
`,
);
processor.main = processorEntry;
write("media-processor", processor);

for (const dir of [jobsDir, processorDir]) {
  const link = resolve(dir, ".dev.vars");
  if (!existsSync(link)) writeFileSync(link, "", { mode: 0o600 });
}

console.log(`jobs worker config: ${jobsDir}/wrangler.json`);
console.log(`media processor config: ${processorDir}/wrangler.json`);
console.log("provider values are not written here; the launch script injects them from Infisical.");
