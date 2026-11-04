import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { parseHnsForwarderV3KeyRegistry } from "@pirate/platform-cf/hns-forwarder-v3";

export const STAGING_FORWARDER_REFERENCE = "pirate:hns-forwarder-v3:staging-community-app:v1";
export const STAGING_FORWARDER_VERSION = "2026-09-23-01";
export const STAGING_FORWARDER_KEY_ID = "staging-community-app-2026-09-23-01";
const SECRET_NAME = "HNS_FORWARDER_V3_HMAC_KEY_REGISTRY";
const CUSTODY_SIBLING = "CONTROL_PLANE_POSTGRES_RUNTIME_URL";
const PROJECT = "fac45f92-9450-42fb-8c2f-f20d043fdfab";
const PATH = "/services/api-next/operator";
const VALIDITY_SECONDS = 90 * 24 * 60 * 60;

function refuse(code: string): never {
  throw new Error(`staging_forwarder_refused:${code}`);
}

export function makeStagingForwarderRegistry(now: number, key: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 300) refuse("time");
  if (key.byteLength !== 32) refuse("key_length");
  const document = {
    schema: "pirate-hns-forwarder-v3-key-registry-v1",
    registry_reference: STAGING_FORWARDER_REFERENCE,
    registry_version: STAGING_FORWARDER_VERSION,
    keys: [
      {
        key_id: STAGING_FORWARDER_KEY_ID,
        key_base64url: Buffer.from(key).toString("base64url"),
        signing_enabled: true,
        verify_not_before: now - 300,
        verify_not_after: now + VALIDITY_SECONDS,
      },
    ],
  };
  const serialized = JSON.stringify(document);
  const parsed = parseHnsForwarderV3KeyRegistry(
    serialized,
    STAGING_FORWARDER_REFERENCE,
    STAGING_FORWARDER_VERSION,
  );
  if (parsed.signingKey(now)?.key_id !== STAGING_FORWARDER_KEY_ID) refuse("signing_key");
  return serialized;
}

async function infisical(args: string[], value?: string): Promise<string> {
  const child =
    value === undefined
      ? spawn("infisical", args, { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(
          "bash",
          [
            "-c",
            'IFS= read -r -d "" payload || :; infisical "$@" 3<<< "$payload"',
            "staging-forwarder-custody",
            ...args,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
  if (!child.stdout || !child.stderr) refuse("transport");
  const chunks: Buffer[] = [];
  child.stdout.on("data", (part: Buffer) => chunks.push(part));
  child.stderr.resume();
  if (value !== undefined) {
    if (!child.stdin) refuse("transport");
    child.stdin.end(value);
  }
  const status = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  if (status !== 0) refuse("secret_custody");
  return Buffer.concat(chunks).toString("utf8");
}

function verify(value: string, now: number): void {
  const registry = parseHnsForwarderV3KeyRegistry(
    value,
    STAGING_FORWARDER_REFERENCE,
    STAGING_FORWARDER_VERSION,
  );
  if (registry.signingKey(now)?.key_id !== STAGING_FORWARDER_KEY_ID) refuse("registry_not_active");
}

/** Reads the custody folder itself, by key name only. The process environment
 * is not evidence of absence: running without `infisical run` would otherwise
 * let --execute replace the live registry and split gateway and Workers. */
export async function custodiedRegistryExists(
  list: () => Promise<string> = () =>
    infisical([
      "secrets",
      "--env=staging",
      `--path=${PATH}`,
      `--projectId=${PROJECT}`,
      "--silent",
      "-o",
      "json",
    ]),
): Promise<boolean> {
  const listing = await list();
  let entries: unknown;
  try {
    entries = JSON.parse(listing);
  } catch {
    refuse("custody_listing_unreadable");
  }
  if (!Array.isArray(entries)) refuse("custody_listing_unreadable");
  const keys = (entries as unknown[]).map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      refuse("custody_listing_unreadable");
    const key = (entry as { secretKey?: unknown }).secretKey;
    if (typeof key !== "string" || key.length === 0) refuse("custody_listing_unreadable");
    return key;
  });
  if (!keys.includes(CUSTODY_SIBLING)) refuse("custody_scope_unproven");
  if (new Set(keys).size !== keys.length) refuse("custody_listing_unreadable");
  return keys.includes(SECRET_NAME);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--plan" && mode !== "--execute" && mode !== "--verify") refuse("usage");
  const now = Math.floor(Date.now() / 1000);
  const existing = process.env[SECRET_NAME];
  if (mode === "--verify") {
    if (!existing) refuse("missing");
    verify(existing, now);
    process.stdout.write(
      `${JSON.stringify({ outcome: "staging_forwarder_verified", reference: STAGING_FORWARDER_REFERENCE, version: STAGING_FORWARDER_VERSION, key_id: STAGING_FORWARDER_KEY_ID, sha256: createHash("sha256").update(existing).digest("hex") })}\n`,
    );
    return;
  }
  if (existing || (await custodiedRegistryExists())) refuse("already_exists");
  if (mode === "--plan") {
    process.stdout.write(
      `${JSON.stringify({ outcome: "staging_forwarder_plan", reference: STAGING_FORWARDER_REFERENCE, version: STAGING_FORWARDER_VERSION, key_id: STAGING_FORWARDER_KEY_ID, validity_days: 90, secret_name: SECRET_NAME })}\n`,
    );
    return;
  }
  const serialized = makeStagingForwarderRegistry(now, randomBytes(32));
  await infisical(
    [
      "secrets",
      "set",
      "--file=/dev/fd/3",
      "--env=staging",
      `--path=${PATH}`,
      `--projectId=${PROJECT}`,
      "--silent",
    ],
    `${SECRET_NAME}=${serialized}\n`,
  );
  const readback = await infisical([
    "secrets",
    "get",
    SECRET_NAME,
    "--plain",
    "--env=staging",
    `--path=${PATH}`,
    `--projectId=${PROJECT}`,
    "--silent",
  ]);
  if (readback.trim() !== serialized) refuse("readback_mismatch");
  verify(readback.trim(), now);
  process.stdout.write(
    `${JSON.stringify({ outcome: "staging_forwarder_custodied", reference: STAGING_FORWARDER_REFERENCE, version: STAGING_FORWARDER_VERSION, key_id: STAGING_FORWARDER_KEY_ID, sha256: createHash("sha256").update(serialized).digest("hex"), verify_not_after: now + VALIDITY_SECONDS })}\n`,
  );
}

if (import.meta.main)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error && error.message.startsWith("staging_forwarder_refused:") ? error.message : "staging_forwarder_refused:unexpected"}\n`,
    );
    process.exitCode = 1;
  });
