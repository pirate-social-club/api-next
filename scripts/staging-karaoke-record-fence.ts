import { Client } from "pg";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  FenceEvidence,
  ResidualDisposition,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  reconciliationMillis,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KaraokeResetSnapshotSchema } from "../packages/platform-cf/src/karaoke-reset-inspection.ts";
import {
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_OBJECT_IDS,
  KaraokeResetTarget,
} from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import { admitKaraokeResetOperator } from "../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import { appendKaraokeMaintenanceEvent } from "./karaoke-maintenance-journal.ts";
import { readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import { normalizePostgresConnectionString } from "./postgres-connection-string.ts";
import {
  KaraokeAuthorityBaseline,
  type KaraokeCollectorInput,
  loadKaraokeCollectorConfiguration,
} from "./staging-karaoke-collector-config.ts";
import { inspectStagingKaraokeObject } from "./staging-karaoke-inspection-client.ts";
import { observeKaraokeSqlIdentity } from "./staging-karaoke-nonreuse.ts";
import { collectStagingMaintenanceFence } from "./staging-persona-maintenance-fence.ts";
import { collectStagingProviderBinding } from "./staging-persona-target-binding.ts";

/** Explicit authenticated local journal creation, after actual maintained-fence
 * observation. This has no install, DELETE, reset or release capability.
 * Null authority cannot be bootstrapped from a current empty inspection.
 */
export async function recordStagingKaraokeFence(
  input: KaraokeCollectorInput,
  dependencies: {
    readonly authenticationFetch?: CloudflareAccessJwtFetch;
    readonly observeFence?: (
      input: Parameters<typeof collectStagingMaintenanceFence>[0],
    ) => Promise<{
      readonly fence: typeof FenceEvidence.Type;
      readonly supporting: unknown;
      readonly executionAuthorized: false;
    }>;
    readonly inspect?: typeof inspectStagingKaraokeObject;
    readonly observeIdentity?: typeof readBaselineIdentity;
  } = {},
) {
  const started = Date.now();
  const { config, operator, challenge, assertion, privateKeyPem, journalTrust } =
    loadKaraokeCollectorConfiguration(input);
  await admitKaraokeResetOperator(operator.operator, assertion, dependencies.authenticationFetch);
  if (
    config.expectedJournalHead !== null ||
    config.baselineIds.length !== 0 ||
    Object.keys(operator.expectedHistory).sort().join() !==
      [...KARAOKE_RESET_OBJECT_IDS].sort().join() ||
    Object.values(operator.expectedHistory).some((history) => history.length !== 0)
  )
    throw new Error("karaoke_journal_initialization_denied");
  const dispositionBytes = readKaraokePrivateFile(config.residualDispositionPath, 262_144);
  const disposition = decodeReconciliation(ResidualDisposition, JSON.parse(dispositionBytes));
  if (
    reconciliationDigest(dispositionBytes) !== operator.residualDispositionId ||
    disposition.epoch !== operator.epoch ||
    disposition.bucket !== operator.bucket
  )
    throw new Error("karaoke_journal_disposition_denied");
  const fence = await (dependencies.observeFence ?? collectStagingMaintenanceFence)({
    pins: config.pins,
    apiToken: input.apiToken,
    residualDispositionId: operator.residualDispositionId,
  });
  const admittedFence = decodeReconciliation(FenceEvidence, fence.fence);
  if (
    !admittedFence.ingress ||
    !admittedFence.producers ||
    !admittedFence.databaseWrites ||
    !admittedFence.reconnectDenied ||
    admittedFence.runtimeSessions !== 0 ||
    admittedFence.residualDispositionId !== operator.residualDispositionId ||
    reconciliationMillis(admittedFence.verifiedAt) < started ||
    reconciliationMillis(admittedFence.verifiedAt) > Date.now()
  )
    throw new Error("karaoke_journal_fence_unproven");
  const artifacts = [
    dispositionBytes,
    JSON.stringify({ kind: "fence-challenge", challenge }),
    JSON.stringify(fence),
  ];
  const baselineIds: string[] = [];
  try {
    for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
      const target = decodeReconciliation(KaraokeResetTarget, {
        namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
        objectId,
        generation: KARAOKE_RESET_GENERATION,
        inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
      });
      const snapshot = decodeReconciliation(
        KaraokeResetSnapshotSchema,
        await (dependencies.inspect ?? inspectStagingKaraokeObject)({
          origin: config.inspectionOrigin,
          assertion,
          target,
        }),
      );
      if (
        Object.entries(target).some(([key, value]) => Reflect.get(snapshot, key) !== value) ||
        reconciliationMillis(snapshot.observedAt) < started ||
        reconciliationMillis(snapshot.observedAt) > Date.now() ||
        snapshot.markerState !== "active" ||
        snapshot.initial === null ||
        snapshot.installationReceipt === null ||
        !snapshot.installationReceipt.cancellationSucceeded ||
        snapshot.current.alarm !== null ||
        snapshot.current.sockets !== 0
      )
        throw new Error("karaoke_journal_marker_unproven");
      if (snapshot.authority === null)
        throw new Error("karaoke_journal_negative_history_adapter_required");
      const observed = await (dependencies.observeIdentity ?? readBaselineIdentity)(
        snapshot.authority,
      );
      if (
        observed.state !== "present" ||
        observed.identity.accountId !== snapshot.authority.accountId ||
        observed.identity.attemptId !== snapshot.authority.attemptId ||
        reconciliationMillis(observed.observedAt) < started ||
        reconciliationMillis(observed.observedAt) > Date.now()
      )
        throw new Error("karaoke_journal_baseline_missing");
      if (
        [snapshot.initial.archiveKey, snapshot.current.archiveKey].some(
          (key) => key !== null && key !== observed.key,
        )
      )
        throw new Error("karaoke_journal_archive_identity_denied");
      const baseline = JSON.stringify(
        decodeReconciliation(KaraokeAuthorityBaseline, {
          version: "staging-karaoke-authority-baseline-v1",
          target,
          epoch: operator.epoch,
          sqlIdentity: observed.identity,
          absentHistory: null,
        }),
      );
      artifacts.push(JSON.stringify(snapshot), baseline);
      baselineIds.push(reconciliationDigest(baseline));
    }
  } catch {
    throw new Error("karaoke_journal_baseline_unproven");
  }
  if (Date.now() < started || Date.now() - started > 60_000)
    throw new Error("karaoke_journal_observation_expired");
  const observedAt = new Date().toISOString();
  const begin = appendKaraokeMaintenanceEvent({
    trust: journalTrust,
    privateKeyPem,
    observedAt,
    event: { kind: "begin", evidenceIds: artifacts.map(reconciliationDigest) },
    artifacts,
  });
  const fenceBytes = JSON.stringify(fence);
  const held = appendKaraokeMaintenanceEvent({
    trust: {
      ...journalTrust,
      expectedHead: { entryId: begin.head.entryId, sequence: begin.head.sequence },
    },
    privateKeyPem,
    observedAt,
    event: { kind: "fence-observed", evidenceIds: [reconciliationDigest(fenceBytes)] },
    artifacts: [fenceBytes],
  });
  return { head: held.head, baselineIds, executionAuthorized: false as const };
}

/** Independently target-bound connection; each identity read owns its transaction. */
async function readBaselineIdentity(authority: {
  readonly accountId: string;
  readonly attemptId: string;
}) {
  const binding = await collectStagingProviderBinding();
  const admin = new Client({
    connectionString: normalizePostgresConnectionString(binding.adminRaw),
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    application_name: "staging-authority-baseline-observer",
  });
  try {
    await admin.connect();
    const identity = (
      await admin.query("SELECT session_user::text AS login,current_user::text AS effective")
    ).rows[0];
    if (identity?.login !== binding.admin.sqlRole || identity.effective !== binding.admin.sqlRole)
      throw new Error("karaoke_journal_sql_identity_denied");
    return await observeKaraokeSqlIdentity(admin, authority);
  } finally {
    await admin.end().catch(() => undefined);
  }
}
