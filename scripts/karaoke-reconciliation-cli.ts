import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  ReconciliationDigest as Digest,
  decodeReconciliation,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import {
  type KaraokeCollectorChallenge,
  openAuthenticatedKaraokeEvidence,
} from "./karaoke-reconciliation-adapter.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const Config = Schema.Struct({
  version: Schema.Literal("staging-karaoke-operator-config-v1"),
  directory: Text,
  collectorPath: Text,
  collectorSourceDigest: Digest,
  collectorPublicKeyPem: Text,
  epoch: Digest,
  bucket: Text,
  residualDispositionId: Digest,
  expectedHistory: Schema.Record(Schema.String, Schema.Array(Digest).check(Schema.isMaxLength(64))),
  operator: Schema.Struct({
    API_NEXT_ENV: Schema.Literal("staging"),
    KARAOKE_RESET_ENABLED: Schema.Literal("true"),
    KARAOKE_RESET_ACCESS_ISSUER: Text,
    KARAOKE_RESET_ACCESS_AUDIENCE: Text,
    KARAOKE_RESET_ACCESS_SUBJECT: Text,
  }),
});

function privateFile(path: string, maximum: number): string {
  if (!isAbsolute(path) || realpathSync(path) !== resolve(path))
    throw new Error("operator_file_path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximum
    ) {
      throw new Error("operator_file_permissions");
    }
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      if (size === 0) break;
      count += size;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      count > maximum ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("operator_file_changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, count),
    );
  } finally {
    closeSync(fd);
  }
}

function outside(directory: string, path: string): boolean {
  const suffix = relative(resolve(directory), resolve(path));
  return suffix.startsWith("../") || suffix === ".." || isAbsolute(suffix);
}

/** No shell, no token argument, no success-by-stdout. The signed artifacts decide. */
function collect(
  config: typeof Config.Type,
  challenge: KaraokeCollectorChallenge,
  assertionPath: string,
): Promise<void> {
  const bundle = privateFile(config.collectorPath, 16_777_216);
  if (reconciliationDigest(bundle) !== config.collectorSourceDigest)
    throw new Error("collector_source_mismatch");
  return new Promise((complete, reject) => {
    // Execute the verified bytes on stdin, avoiding a verify/execute pathname race.
    // Challenge is a small non-secret environment value; the collector reads it
    // via KARAOKE_COLLECTOR_CHALLENGE. The private credential path is separate.
    const child = spawn(
      process.execPath,
      ["run", "-", "collect-karaoke-reconciliation", "--run-directory", config.directory],
      {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...process.env,
          KARAOKE_COLLECTOR_CHALLENGE: JSON.stringify(challenge),
          KARAOKE_COLLECTOR_SOURCE_DIGEST: reconciliationDigest(bundle),
          KARAOKE_COLLECTOR_ACCESS_ASSERTION_FILE: assertionPath,
        },
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("collector_start_failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) complete();
      else reject(new Error("collector_failed"));
    });
    child.stdin.on("error", () => {
      /* Process close determines failure. */
    });
    child.stdin.end(bundle);
  });
}

/** Read-only verification; even an eligible result does not execute the reset. */
export async function runKaraokeReconciliationCli(
  configPath: string,
  assertionPath: string,
  dependencies: {
    readonly now?: () => string;
    readonly authenticationFetch?: CloudflareAccessJwtFetch;
  } = {},
) {
  const config = decodeReconciliation(Config, JSON.parse(privateFile(configPath, 262_144)));
  for (const path of [configPath, assertionPath, config.collectorPath]) {
    if (!outside(config.directory, path)) throw new Error("operator_trust_inside_evidence");
  }
  const assertion = privateFile(assertionPath, 16_384).trim();
  const port = await openAuthenticatedKaraokeEvidence(
    config,
    assertion,
    {
      collect: (challenge) => collect(config, challenge, assertionPath),
    },
    dependencies.now,
    dependencies.authenticationFetch,
  );
  return {
    ...(await verifyKaraokeReconciliation(
      port,
      (dependencies.now ?? (() => new Date().toISOString()))(),
    )),
    executionAuthorized: false as const,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--config" || args[2] !== "--assertion-file") {
    console.error(
      "Usage: bun scripts/karaoke-reconciliation-cli.ts --config <private-file> --assertion-file <private-file>",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await runKaraokeReconciliationCli(args[1] ?? "", args[3] ?? "")));
    } catch {
      console.error("karaoke_reconciliation_verification_denied");
      process.exitCode = 1;
    }
  }
}
