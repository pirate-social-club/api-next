import { Schema } from "effect";
import {
  HistoryEvidence,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetTarget } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import type { KaraokeJournalTrust } from "./karaoke-maintenance-journal.ts";
import { KaraokeOperatorConfig } from "./karaoke-operator-config.ts";
import { outsideKaraokeEvidence, readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import { KaraokeSqlIdentity } from "./staging-karaoke-nonreuse.ts";
import { StagingMaintenancePins } from "./staging-persona-maintenance-fence.ts";

export interface KaraokeCollectorInput {
  readonly configPath: string;
  readonly assertionPath: string;
  readonly runDirectory: string;
  readonly sourceDigest: string;
  readonly challengeJson: string;
  readonly apiToken: string;
}

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const KaraokeLiveCollectorConfig = Schema.Struct({
  version: Schema.Literal("staging-karaoke-live-collector-v1"),
  operatorConfigPath: Path,
  signingKeyPath: Path,
  inspectionOrigin: Path,
  journalDirectory: Path,
  residualDispositionPath: Path,
  expectedJournalHead: Schema.NullOr(
    Schema.Struct({
      entryId: ReconciliationDigest,
      sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8191 })),
    }),
  ),
  baselineIds: Schema.Array(ReconciliationDigest).check(
    Schema.isMinLength(0),
    Schema.isMaxLength(6),
  ),
  pins: StagingMaintenancePins,
});
export const KaraokeAuthorityBaseline = Schema.Struct({
  version: Schema.Literal("staging-karaoke-authority-baseline-v1"),
  target: KaraokeResetTarget,
  epoch: ReconciliationDigest,
  sqlIdentity: Schema.NullOr(KaraokeSqlIdentity),
  // Null authority requires independently retained, authenticated non-deletion
  // history. An empty current inspection alone can never produce this evidence.
  absentHistory: Schema.NullOr(HistoryEvidence),
});
const Challenge = Schema.Struct({
  version: Schema.Literal("staging-karaoke-collector-challenge-v1"),
  challenge: ReconciliationDigest,
  operatorSubjectDigest: ReconciliationDigest,
  epoch: ReconciliationDigest,
  bucket: Schema.String,
});

export function loadKaraokeCollectorConfiguration(input: KaraokeCollectorInput) {
  const config = decodeReconciliation(
    KaraokeLiveCollectorConfig,
    JSON.parse(readKaraokePrivateFile(input.configPath, 262_144)),
  );
  const operator = decodeReconciliation(
    KaraokeOperatorConfig,
    JSON.parse(readKaraokePrivateFile(config.operatorConfigPath, 262_144)),
  );
  const challenge = decodeReconciliation(Challenge, JSON.parse(input.challengeJson));
  for (const directory of [operator.directory, config.journalDirectory])
    for (const path of [
      input.configPath,
      config.operatorConfigPath,
      input.assertionPath,
      config.signingKeyPath,
      operator.collectorPath,
      config.residualDispositionPath,
    ])
      if (!outsideKaraokeEvidence(directory, path))
        throw new Error("collector_trust_inside_evidence");
  if (
    input.runDirectory !== operator.directory ||
    input.sourceDigest !== operator.collectorSourceDigest ||
    reconciliationDigest(readKaraokePrivateFile(operator.collectorPath, 16_777_216)) !==
      input.sourceDigest ||
    !input.apiToken ||
    operator.bucket !== "pirate-learner-audio-staging" ||
    challenge.epoch !== operator.epoch ||
    challenge.bucket !== operator.bucket ||
    challenge.operatorSubjectDigest !==
      reconciliationDigest(operator.operator.KARAOKE_RESET_ACCESS_SUBJECT)
  )
    throw new Error("collector_configuration_denied");
  const assertion = readKaraokePrivateFile(input.assertionPath, 16_384).trim();
  const privateKeyPem = readKaraokePrivateFile(config.signingKeyPath, 16_384);
  const journalTrust: KaraokeJournalTrust = {
    directory: config.journalDirectory,
    publicKeyPem: operator.collectorPublicKeyPem,
    epoch: operator.epoch,
    collectorSourceDigest: operator.collectorSourceDigest,
    expectedHead: config.expectedJournalHead,
  };
  return { config, operator, challenge, assertion, privateKeyPem, journalTrust };
}
