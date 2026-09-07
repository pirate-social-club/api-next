import { randomBytes } from "node:crypto";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { decodeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { admitKaraokeResetOperator } from "../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import { KaraokeOperatorConfig } from "./karaoke-operator-config.ts";
import { outsideKaraokeEvidence, readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import type { KaraokeCollectorChallenge } from "./karaoke-reconciliation-adapter.ts";
import { loadKaraokeCollectorConfiguration } from "./staging-karaoke-collector-config.ts";

/** Authenticate before executing the pinned child; no command can take trust
 * roots or credentials from its output directory. */
export async function prepareKaraokeRecording(configPath: string, assertionPath: string) {
  const config = decodeReconciliation(
    KaraokeOperatorConfig,
    JSON.parse(readKaraokePrivateFile(configPath, 262_144)),
  );
  for (const path of [configPath, assertionPath, config.collectorPath])
    if (!outsideKaraokeEvidence(config.directory, path))
      throw new Error("operator_trust_inside_evidence");
  const assertion = readKaraokePrivateFile(assertionPath, 16_384).trim();
  await admitKaraokeResetOperator(config.operator, assertion);
  const started = Date.now();
  const challenge: KaraokeCollectorChallenge = {
    version: "staging-karaoke-collector-challenge-v1",
    challenge: randomBytes(32).toString("hex"),
    operatorSubjectDigest: reconciliationDigest(config.operator.KARAOKE_RESET_ACCESS_SUBJECT),
    epoch: config.epoch,
    bucket: config.bucket,
  };
  const livePath = process.env.KARAOKE_LIVE_COLLECTOR_CONFIG;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!livePath || !apiToken) throw new Error("collector_configuration_missing");
  const live = loadKaraokeCollectorConfiguration({
    configPath: livePath,
    assertionPath,
    runDirectory: config.directory,
    sourceDigest: config.collectorSourceDigest,
    challengeJson: JSON.stringify(challenge),
    apiToken,
  });
  if (live.config.operatorConfigPath !== configPath)
    throw new Error("collector_configuration_scope_denied");
  return { config, live, challenge, started };
}
