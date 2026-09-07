import { Schema } from "effect";
import { Client } from "pg";
import {
  HistoryEvidence,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import {
  KARAOKE_RESET_OBJECT_IDS,
  KaraokeResetTarget,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import {
  type KaraokeJournalTrust,
  readKaraokeMaintenanceJournal,
} from "./karaoke-maintenance-journal.ts";
import { KaraokeOperatorConfig } from "./karaoke-operator-config.ts";
import { outsideKaraokeEvidence, readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import { inspectStagingKaraokeObject } from "./staging-karaoke-inspection-client.ts";
import {
  KaraokeSqlIdentity,
  observeKaraokeSqlIdentity,
  verifyKaraokeSqlNonReuse,
} from "./staging-karaoke-nonreuse.ts";
import { collectSignedKaraokeReconciliation } from "./staging-karaoke-signing-collector.ts";
import {
  collectStagingMaintenanceFence,
  StagingMaintenancePins,
} from "./staging-persona-maintenance-fence.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Config = Schema.Struct({
  version: Schema.Literal("staging-karaoke-live-collector-v1"),
  operatorConfigPath: Path,
  signingKeyPath: Path,
  inspectionOrigin: Path,
  journalDirectory: Path,
  expectedJournalHead: Schema.Struct({
    entryId: ReconciliationDigest,
    sequence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8191 })),
  }),
  baselineIds: Schema.Array(ReconciliationDigest).check(
    Schema.isMinLength(6),
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

/** Default child entrypoint: credentials stay in memory/private files. Every
 * observation is made by concrete HTTP, SSH or PostgreSQL readers, not fixtures.
 */
export async function runStagingKaraokeCollector(input: {
  readonly configPath: string;
  readonly assertionPath: string;
  readonly runDirectory: string;
  readonly sourceDigest: string;
  readonly challengeJson: string;
  readonly apiToken: string;
}) {
  const config = decodeReconciliation(
    Config,
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
    ])
      if (!outsideKaraokeEvidence(directory, path))
        throw new Error("collector_trust_inside_evidence");
  if (
    input.runDirectory !== operator.directory ||
    input.sourceDigest !== operator.collectorSourceDigest ||
    reconciliationDigest(readKaraokePrivateFile(operator.collectorPath, 16_777_216)) !==
      input.sourceDigest ||
    !input.apiToken ||
    operator.bucket !== "pirate-learner-audio-staging"
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
  const journal = readKaraokeMaintenanceJournal(journalTrust, new Date().toISOString());
  const baselines = config.baselineIds.map((id) =>
    decodeReconciliation(KaraokeAuthorityBaseline, JSON.parse(journal.readArtifact(id))),
  );
  if (
    new Set(baselines.map((value) => value.target.objectId)).size !== 6 ||
    baselines.some((value) => value.epoch !== operator.epoch) ||
    KARAOKE_RESET_OBJECT_IDS.some((id) => !baselines.some((value) => value.target.objectId === id))
  )
    throw new Error("collector_baseline_inventory_denied");
  let bindingRead: ReturnType<typeof collectStagingProviderBinding> | undefined;
  return collectSignedKaraokeReconciliation({
    trust: operator,
    journal: journalTrust,
    privateKeyPem,
    assertion,
    challenge,
    readers: {
      inspect: (target) =>
        inspectStagingKaraokeObject({ origin: config.inspectionOrigin, assertion, target }),
      observeMaintainedFence: async () =>
        await collectStagingMaintenanceFence({
          pins: config.pins,
          apiToken: input.apiToken,
          residualDispositionId: operator.residualDispositionId,
        }),
      async verifyNonReuse(snapshot, phase) {
        const baseline = baselines.find((value) => value.target.objectId === snapshot.objectId);
        if (!baseline) throw new Error("collector_baseline_missing");
        if (baseline.sqlIdentity === null) {
          if (
            snapshot.authority !== null ||
            snapshot.initial === null ||
            snapshot.initial.archiveKey !== null ||
            snapshot.current.archiveKey !== null ||
            baseline.absentHistory?.storageNeverDeleted !== true ||
            baseline.absentHistory.namespaceUnchanged !== true
          )
            throw new Error("collector_negative_history_unproven");
          return { keyNotReused: true, observedAt: new Date().toISOString() };
        }
        if (
          snapshot.authority?.accountId !== baseline.sqlIdentity.accountId ||
          snapshot.authority.attemptId !== baseline.sqlIdentity.attemptId ||
          baseline.absentHistory !== null
        )
          throw new Error("collector_authority_changed");
        bindingRead ??= collectStagingProviderBinding();
        const binding = await bindingRead;
        const admin = new Client({
          connectionString: normalizePostgresConnectionString(binding.adminRaw),
          connectionTimeoutMillis: 3000,
          query_timeout: 5000,
          application_name: "staging-key-nonreuse-observer",
        });
        try {
          await admin.connect();
          const identity = (
            await admin.query("SELECT session_user::text AS login,current_user::text AS effective")
          ).rows[0];
          if (
            identity?.login !== binding.admin.sqlRole ||
            identity.effective !== binding.admin.sqlRole
          )
            throw new Error("collector_sql_identity_denied");
          const observed = await observeKaraokeSqlIdentity(admin, snapshot.authority);
          return verifyKaraokeSqlNonReuse(baseline.sqlIdentity, observed, phase);
        } catch {
          throw new Error("collector_nonreuse_unproven");
        } finally {
          await admin.end().catch(() => undefined);
        }
      },
    },
  });
}
