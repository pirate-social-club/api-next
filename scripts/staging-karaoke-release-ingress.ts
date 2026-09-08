import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { makeKaraokeReleaseHttp } from "./staging-karaoke-release-http.ts";
import type { KaraokeReleaseSurfaces } from "./staging-karaoke-release-operation.ts";
import {
  collectStagingIngressFence,
  selectStagingIngressApplication,
  verifyStagingIngressBlockPolicies,
} from "./staging-persona-ingress-collector.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{32,36}$/u));
export const KaraokeIngressRestoration = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("restore-policy"),
    policyId: Id,
    applicationDigest: ReconciliationDigest,
    policyBody: Schema.Record(Schema.String, Schema.Unknown),
    restoredPolicyDigest: ReconciliationDigest,
  }),
  Schema.Struct({
    kind: Schema.Literal("remove-fence-application"),
    remainingApplicationsDigest: ReconciliationDigest,
  }),
]);

/** Canonical full provider configuration, except provider-maintained timestamps.
 * Every other field participates, including fields this runner does not know.
 * Unknown/defaulted settings therefore refuse instead of being approximated. */
export function karaokeAccessConfigurationDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  const withoutMetadata = (item: unknown) => {
    const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(item);
    return Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "created_at" && key !== "updated_at"),
    );
  };
  return reconciliationDigest(
    JSON.stringify(
      canonical(Array.isArray(value) ? value.map(withoutMetadata) : withoutMetadata(value)),
    ),
  );
}

/** An explicit reviewed reversal, never deletion inferred from absence. Both
 * alternatives re-read complete provider inventory. Configuration unavailable,
 * mixed policies, or failed reads are errors, never restored state. */
export function makeKaraokeIngressRelease(configuration: {
  readonly applicationId: string;
  readonly restoration: typeof KaraokeIngressRestoration.Type;
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const input = { ...configuration };
  const applicationId = decodeReconciliation(Id, input.applicationId);
  const restoration = decodeReconciliation(
    KaraokeIngressRestoration,
    structuredClone(input.restoration),
  );
  if (restoration.kind === "restore-policy") {
    Schema.decodeUnknownSync(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1)),
        decision: Schema.Literals(["allow", "bypass", "non_identity"]),
        include: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1)),
      }),
    )(restoration.policyBody);
  }
  const http = makeKaraokeReleaseHttp(input);
  const inventory = async () => {
    const apps = await http.list("/access/apps");
    const identified = apps
      .map((app) => ({ id: Schema.decodeUnknownSync(Schema.Struct({ id: Id }))(app).id, app }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(identified.map((app) => app.id)).size !== identified.length)
      throw new Error("karaoke_release_ingress_duplicate");
    return identified;
  };
  const scan = async () => {
    const apps = await inventory();
    if (restoration.kind === "remove-fence-application") {
      if (
        apps.some((app) => app.id === applicationId) ||
        karaokeAccessConfigurationDigest(apps.map((app) => app.app)) !==
          restoration.remainingApplicationsDigest
      )
        throw new Error("karaoke_release_ingress_inventory_changed");
      return { applicationsDigest: restoration.remainingApplicationsDigest };
    }
    selectStagingIngressApplication(
      apps.map((app) => app.app),
      applicationId,
    );
    const app = await http(`/access/apps/${applicationId}`, "GET");
    if (karaokeAccessConfigurationDigest(app) !== restoration.applicationDigest)
      throw new Error("karaoke_release_ingress_application_changed");
    const policies = await http.list(`/access/apps/${applicationId}/policies`);
    if (
      policies.length !== 1 ||
      Schema.decodeUnknownSync(Schema.Struct({ id: Id }))(policies[0]).id !==
        restoration.policyId ||
      karaokeAccessConfigurationDigest(policies[0]) !== restoration.restoredPolicyDigest
    )
      throw new Error("karaoke_release_ingress_policy_changed");
    return {
      applicationDigest: restoration.applicationDigest,
      policyDigest: restoration.restoredPolicyDigest,
    };
  };
  const readback = async () => {
    const first = await scan();
    const second = await scan();
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw new Error("karaoke_release_ingress_readback_changed");
    return second;
  };
  const execute: KaraokeReleaseSurfaces["ingress"] = async (directive, now) => {
    if (JSON.stringify(directive) !== JSON.stringify({ applicationId }))
      throw new Error("karaoke_release_ingress_directive_changed");
    const fence = await collectStagingIngressFence({ ...input, applicationId });
    const apps = await inventory();
    selectStagingIngressApplication(
      apps.map((app) => app.app),
      applicationId,
    );
    let response: unknown;
    if (restoration.kind === "remove-fence-application") {
      if (
        karaokeAccessConfigurationDigest(
          apps.filter((app) => app.id !== applicationId).map((app) => app.app),
        ) !== restoration.remainingApplicationsDigest
      )
        throw new Error("karaoke_release_ingress_inventory_changed");
      response = await http(`/access/apps/${applicationId}`, "DELETE");
      if (Schema.decodeUnknownSync(Schema.Struct({ id: Id }))(response).id !== applicationId)
        throw new Error("karaoke_release_ingress_response_unproven");
    } else {
      if (
        karaokeAccessConfigurationDigest(await http(`/access/apps/${applicationId}`, "GET")) !==
        restoration.applicationDigest
      )
        throw new Error("karaoke_release_ingress_application_changed");
      const policy = verifyStagingIngressBlockPolicies(
        await http.list(`/access/apps/${applicationId}/policies`),
      );
      if (policy.id !== restoration.policyId)
        throw new Error("karaoke_release_ingress_policy_changed");
      response = await http(
        `/access/apps/${applicationId}/policies/${restoration.policyId}`,
        "PUT",
        restoration.policyBody,
      );
      if (karaokeAccessConfigurationDigest(response) !== restoration.restoredPolicyDigest)
        throw new Error("karaoke_release_ingress_response_unproven");
    }
    const providerEvidence = JSON.stringify({
      fence,
      responseDigest: karaokeAccessConfigurationDigest(response),
      observed: await readback(),
    });
    return {
      surface: "ingress",
      releasedAt: now(),
      receipt: reconciliationDigest(providerEvidence),
      providerEvidence,
    };
  };
  return {
    execute,
    async observeRestored(): Promise<"restored" | "fenced" | "uncertain"> {
      try {
        await readback();
        return "restored";
      } catch {
        return "uncertain";
      }
    },
  };
}
