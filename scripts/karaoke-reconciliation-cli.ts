import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import { verifyKaraokeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation.ts";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { decodeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeOperatorConfig } from "./karaoke-operator-config.ts";
import { outsideKaraokeEvidence, readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import {
  type KaraokeCollectorChallenge,
  openAuthenticatedKaraokeEvidence,
} from "./karaoke-reconciliation-adapter.ts";

/** No shell, no token argument, no success-by-stdout. The signed artifacts decide. */
function collect(
  config: typeof KaraokeOperatorConfig.Type,
  challenge: KaraokeCollectorChallenge,
  assertionPath: string,
): Promise<void> {
  const bundle = readKaraokePrivateFile(config.collectorPath, 16_777_216);
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
  const config = decodeReconciliation(
    KaraokeOperatorConfig,
    JSON.parse(readKaraokePrivateFile(configPath, 262_144)),
  );
  for (const path of [configPath, assertionPath, config.collectorPath]) {
    if (!outsideKaraokeEvidence(config.directory, path))
      throw new Error("operator_trust_inside_evidence");
  }
  const assertion = readKaraokePrivateFile(assertionPath, 16_384).trim();
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
