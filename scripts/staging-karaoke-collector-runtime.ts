import { Client } from "pg";
import { decodeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  KaraokeAuthorityBaseline,
  type KaraokeCollectorInput,
  loadKaraokeCollectorConfiguration,
} from "./staging-karaoke-collector-config.ts";
import { inspectStagingKaraokeObject } from "./staging-karaoke-inspection-client.ts";
import { observeKaraokeSqlIdentity, verifyKaraokeSqlNonReuse } from "./staging-karaoke-nonreuse.ts";
import { collectSignedKaraokeReconciliation } from "./staging-karaoke-signing-collector.ts";
import { collectStagingMaintenanceFence } from "./staging-persona-maintenance-fence.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/** Default child entrypoint: credentials stay in memory/private files. Every
 * observation is made by concrete HTTP, SSH or PostgreSQL readers, not fixtures.
 */
export async function runStagingKaraokeCollector(input: KaraokeCollectorInput) {
  const { config, operator, challenge, assertion, privateKeyPem, journalTrust } =
    loadKaraokeCollectorConfiguration(input);
  if (config.expectedJournalHead === null || config.baselineIds.length !== 6)
    throw new Error("collector_journal_not_initialized");
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
