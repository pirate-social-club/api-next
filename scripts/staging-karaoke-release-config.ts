import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { outsideKaraokeEvidence, readKaraokePrivateFile } from "./karaoke-private-trust.ts";
import type { loadKaraokeCollectorConfiguration } from "./staging-karaoke-collector-config.ts";
import { KaraokeIngressRestoration } from "./staging-karaoke-release-ingress.ts";
import { KaraokeReleasePlan } from "./staging-karaoke-release-operation.ts";
import { KaraokeReleasedSchedules } from "./staging-karaoke-release-producers.ts";

export const KaraokeLiveReleaseConfiguration = Schema.Struct({
  version: Schema.Literal("staging-karaoke-live-release-v1"),
  approvedPlanDigest: ReconciliationDigest,
  plan: KaraokeReleasePlan,
  restoration: Schema.Struct({
    ingress: KaraokeIngressRestoration,
    database: Schema.Struct({
      targetBindingDigest: ReconciliationDigest,
      restoreRuntimeConnect: Schema.Literal(true),
    }),
    producers: Schema.Struct({ schedules: KaraokeReleasedSchedules }),
  }),
});

export function validateKaraokeReleaseConfiguration(value: unknown) {
  const config = decodeReconciliation(KaraokeLiveReleaseConfiguration, value);
  if (
    config.plan.restorationDigest !== reconciliationDigest(JSON.stringify(config.restoration)) ||
    config.approvedPlanDigest !== reconciliationDigest(JSON.stringify(config.plan))
  )
    throw new Error("karaoke_release_approved_plan_changed");
  if (JSON.stringify(config.plan.surfaceOrder) !== '["database","producers","ingress"]')
    throw new Error("karaoke_release_approved_order_changed");
  return config;
}

/** Private operator input, not output evidence. The approval digest comes
 * from the recorded owner approval; this CLI never generates approval. */
export function loadKaraokeReleaseConfiguration(
  context: ReturnType<typeof loadKaraokeCollectorConfiguration>,
) {
  const path = process.env.KARAOKE_LIVE_RELEASE_CONFIG;
  if (!path) throw new Error("karaoke_release_configuration_missing");
  if (
    !outsideKaraokeEvidence(context.operator.directory, path) ||
    !outsideKaraokeEvidence(context.config.journalDirectory, path)
  )
    throw new Error("karaoke_release_trust_inside_evidence");
  const config = validateKaraokeReleaseConfiguration(
    JSON.parse(readKaraokePrivateFile(path, 262_144)),
  );
  if (
    config.plan.ingressApplicationId !== context.config.pins.ingressApplicationId ||
    JSON.stringify([...config.plan.resumeQueues].sort((a, b) => a.id.localeCompare(b.id))) !==
      JSON.stringify([...context.config.pins.queues].sort((a, b) => a.id.localeCompare(b.id)))
  )
    throw new Error("karaoke_release_held_target_changed");
  return config;
}
