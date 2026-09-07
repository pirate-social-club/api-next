import { Schema } from "effect";
import { FenceEvidence } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import { decodeReconciliation } from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import {
  collectStagingCloudflareProducers,
  STAGING_FENCED_QUEUES,
} from "./staging-persona-cloudflare-producers.ts";
import { collectStagingDatabaseFence } from "./staging-persona-database-collector.ts";
import {
  collectStagingWorkerDeployments,
  STAGING_PRODUCER_WORKERS,
} from "./staging-persona-deployment-collector.ts";
import {
  collectStagingExternalProducers,
  ExternalProducerPin,
} from "./staging-persona-external-observation.ts";
import { collectStagingIngressFence } from "./staging-persona-ingress-collector.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{32,36}$/u));
export const StagingMaintenancePins = Schema.Struct({
  accountId: Schema.Literal("08a4c22cf52e2ecae883e36f80a33f4a"),
  ingressApplicationId: Id,
  reviewedVersions: Schema.Array(
    Schema.Struct({ worker: Schema.Literals(STAGING_PRODUCER_WORKERS), versionId: Id }),
  ),
  queues: Schema.Array(Schema.Struct({ name: Schema.Literals(STAGING_FENCED_QUEUES), id: Id })),
  external: Schema.Array(ExternalProducerPin),
});

/** The actual provider observers compose the fence; there is no input boolean
 * and no provider/state mutation. External pins require independent destination review.
 */
export async function collectStagingMaintenanceFence(input: {
  readonly pins: typeof StagingMaintenancePins.Type;
  readonly apiToken: string;
  readonly residualDispositionId: string;
}) {
  const pins = decodeReconciliation(StagingMaintenancePins, input.pins);
  // Ingress must be observed first. Database denial alone never stands for ingress.
  const ingress = await collectStagingIngressFence({
    accountId: pins.accountId,
    apiToken: input.apiToken,
    applicationId: pins.ingressApplicationId,
  });
  const [workers, cloudflare, external, database] = await Promise.all([
    collectStagingWorkerDeployments({
      accountId: pins.accountId,
      apiToken: input.apiToken,
      reviewedVersions: pins.reviewedVersions,
    }),
    collectStagingCloudflareProducers({
      accountId: pins.accountId,
      apiToken: input.apiToken,
      queues: pins.queues,
    }),
    collectStagingExternalProducers({ pins: pins.external }),
    collectStagingDatabaseFence(),
  ]);
  const fence = decodeReconciliation(FenceEvidence, {
    verifiedAt: new Date().toISOString(),
    ingress: ingress.ingressDenied,
    producers: true,
    databaseWrites: database.databaseWrites,
    reconnectDenied: database.reconnectDenied,
    runtimeSessions: database.runtimeSessions,
    residualDispositionId: input.residualDispositionId,
  });
  return {
    fence,
    supporting: { ingress, workers, cloudflare, external, database },
    executionAuthorized: false as const,
  };
}
