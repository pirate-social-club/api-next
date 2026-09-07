import { createHash } from "node:crypto";

export const STAGING_HTTP_WORKER_ID = "7ada21fbaf794466bae2eda487299555";
export const STAGING_HTTP_CUSTOM_DOMAIN = "api-next-staging.pirate.sc";
export const STAGING_HTTP_WORKERS_DEV =
  "pirate-http-worker-staging.piratesocialclub.workers.dev";
export const STAGING_API_SOURCE_SHA = "ba0fd44529d834f491879126cdb8c67c4ec9fcdc";
export const STAGING_SOLID_SOURCE_SHA = "fa5ce5eff47967efb5f13c04de01e75293d3e230";

const hosts = [STAGING_HTTP_CUSTOM_DOMAIN, STAGING_HTTP_WORKERS_DEV] as const;
const sha = /^[a-f0-9]{40}$/u;
const id = /^[a-zA-Z0-9_-]{1,128}$/u;

export type IngressHost = (typeof hosts)[number];

export interface AccessApplicationObservation {
  readonly id: string;
  readonly kind: "worker" | "hostname" | "path";
  readonly workerId: string | null;
  readonly hostnames: readonly string[];
  readonly paths: readonly string[];
  readonly action: "deny" | "allow";
  readonly enabled: boolean;
}

export interface IngressProbeObservation {
  readonly host: string;
  readonly status: number;
  readonly denied: boolean;
  readonly accessApplicationId: string | null;
}

export interface PersistentIngressFencePlan {
  readonly workerId: typeof STAGING_HTTP_WORKER_ID;
  readonly hosts: readonly [IngressHost, IngressHost];
  readonly runtimePins: {
    readonly api: typeof STAGING_API_SOURCE_SHA;
    readonly solid: typeof STAGING_SOLID_SOURCE_SHA;
  };
  readonly existingApplicationId: string | null;
  readonly action: "verify-existing-worker-policy" | "create-worker-policy";
  readonly survivesNormalDeploy: true;
}

export interface PersistentIngressFenceObservation {
  readonly workerId: string;
  readonly customDomain: string;
  readonly workersDevHostname: string;
  readonly previewIngressEnabled: boolean;
  readonly workerLevelApplication: AccessApplicationObservation | null;
  readonly moreSpecificApplications: readonly AccessApplicationObservation[];
  readonly deploymentPins: {
    readonly api: string;
    readonly solid: string;
  };
  readonly probes: readonly IngressProbeObservation[];
}

function assertSha(value: string, error: string): void {
  if (!sha.test(value)) throw new Error(error);
}

function assertId(value: string, error: string): void {
  if (!id.test(value)) throw new Error(error);
}

function assertHost(value: string): asserts value is IngressHost {
  if (!hosts.includes(value as IngressHost)) throw new Error("ingress_host_unproven");
}

function assertWorkerApplication(application: AccessApplicationObservation): void {
  assertId(application.id, "ingress_application_unproven");
  if (
    application.kind !== "worker" ||
    application.workerId !== STAGING_HTTP_WORKER_ID ||
    application.action !== "deny" ||
    application.enabled !== true ||
    application.hostnames.length !== 0 ||
    application.paths.length !== 0
  ) {
    throw new Error("ingress_worker_policy_unproven");
  }
}

function assertNoSpecificOverride(
  applications: readonly AccessApplicationObservation[],
): void {
  for (const application of applications) {
    assertId(application.id, "ingress_application_unproven");
    if (
      application.workerId === STAGING_HTTP_WORKER_ID &&
      application.action === "allow" &&
      (application.hostnames.some((host) => hosts.includes(host as IngressHost)) ||
        application.hostnames.includes("*.pirate.sc") ||
        application.paths.length > 0)
    ) {
      throw new Error("ingress_specific_override");
    }
  }
}

/**
 * Produces the only provider change this lane may hand to an operator: a
 * Worker-level deny policy bound to the fixed HTTP Worker. It deliberately
 * does not call the Access API and never overwrites an existing application.
 * Worker-level policy is external to the Worker deployment, so the policy ID
 * must remain stable across both reviewed API/Solid runtime pins.
 */
export function planPersistentIngressFence(input: {
  readonly workerId: string;
  readonly existingApplications: readonly AccessApplicationObservation[];
  readonly runtimePins: { readonly api: string; readonly solid: string };
}): PersistentIngressFencePlan {
  if (input.workerId !== STAGING_HTTP_WORKER_ID) throw new Error("ingress_worker_unproven");
  if (
    input.runtimePins.api !== STAGING_API_SOURCE_SHA ||
    input.runtimePins.solid !== STAGING_SOLID_SOURCE_SHA
  ) {
    throw new Error("ingress_runtime_pins_unproven");
  }
  assertNoSpecificOverride(input.existingApplications);
  const workerApplications = input.existingApplications.filter(
    (application) => application.kind === "worker" && application.workerId === input.workerId,
  );
  if (workerApplications.length > 1) throw new Error("ingress_worker_policy_ambiguous");
  const workerApplication = workerApplications[0] ?? null;
  if (workerApplication !== null) assertWorkerApplication(workerApplication);
  return Object.freeze({
    workerId: STAGING_HTTP_WORKER_ID,
    hosts,
    runtimePins: {
      api: STAGING_API_SOURCE_SHA,
      solid: STAGING_SOLID_SOURCE_SHA,
    },
    existingApplicationId: workerApplication?.id ?? null,
    action: workerApplication === null ? "create-worker-policy" : "verify-existing-worker-policy",
    survivesNormalDeploy: true,
  });
}

/**
 * Normalizes one public ingress probe. A redirect to an Access login is a
 * denial, but an ordinary application redirect or a 2xx/5xx response is not.
 */
export function normalizeIngressProbe(input: {
  readonly host: string;
  readonly status: number;
  readonly location?: string | null;
  readonly accessApplicationId?: string | null;
}): IngressProbeObservation {
  assertHost(input.host);
  if (!Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new Error("ingress_probe_unproven");
  }
  const location = input.location ?? "";
  const accessRedirect =
    input.status >= 300 &&
    input.status < 400 &&
    /\/cdn-cgi\/access\/login(?:[/?]|$)/u.test(location);
  const denied = input.status === 401 || input.status === 403 || accessRedirect;
  return Object.freeze({
    host: input.host,
    status: input.status,
    denied,
    accessApplicationId: input.accessApplicationId ?? null,
  });
}

/**
 * Verifies the installed external policy after each normal deployment. This
 * requires both public hostnames and both reviewed runtime pins; a maintenance
 * Worker, a single hostname, or a stale deployment cannot satisfy it.
 */
export function verifyPersistentIngressFence(
  observation: PersistentIngressFenceObservation,
  expectedApplicationId: string,
): Readonly<{
  workerId: typeof STAGING_HTTP_WORKER_ID;
  applicationId: string;
  hosts: readonly [IngressHost, IngressHost];
  apiSourceSha: typeof STAGING_API_SOURCE_SHA;
  solidSourceSha: typeof STAGING_SOLID_SOURCE_SHA;
  ingressDenied: true;
  survivesNormalDeploy: true;
}> {
  assertId(expectedApplicationId, "ingress_application_unproven");
  if (
    observation.workerId !== STAGING_HTTP_WORKER_ID ||
    observation.customDomain !== STAGING_HTTP_CUSTOM_DOMAIN ||
    observation.workersDevHostname !== STAGING_HTTP_WORKERS_DEV ||
    observation.previewIngressEnabled !== false
  ) {
    throw new Error("ingress_target_unproven");
  }
  const application = observation.workerLevelApplication;
  if (application === null) throw new Error("ingress_worker_policy_missing");
  assertWorkerApplication(application);
  if (application.id !== expectedApplicationId) throw new Error("ingress_policy_replaced");
  assertNoSpecificOverride(observation.moreSpecificApplications);
  if (
    observation.deploymentPins.api !== STAGING_API_SOURCE_SHA ||
    observation.deploymentPins.solid !== STAGING_SOLID_SOURCE_SHA
  ) {
    throw new Error("ingress_runtime_pins_unproven");
  }
  if (observation.probes.length !== hosts.length) throw new Error("ingress_probe_incomplete");
  const observedHosts = new Set<string>();
  for (const probe of observation.probes) {
    assertHost(probe.host);
    if (observedHosts.has(probe.host) || !probe.denied || probe.accessApplicationId !== expectedApplicationId) {
      throw new Error("ingress_probe_unproven");
    }
    observedHosts.add(probe.host);
  }
  if (hosts.some((host) => !observedHosts.has(host))) throw new Error("ingress_probe_incomplete");
  return Object.freeze({
    workerId: STAGING_HTTP_WORKER_ID,
    applicationId: expectedApplicationId,
    hosts,
    apiSourceSha: STAGING_API_SOURCE_SHA,
    solidSourceSha: STAGING_SOLID_SOURCE_SHA,
    ingressDenied: true,
    survivesNormalDeploy: true,
  });
}

export function ingressFenceFingerprint(value: {
  readonly workerId: string;
  readonly applicationId: string;
  readonly hosts: readonly string[];
  readonly apiSourceSha: string;
  readonly solidSourceSha: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export { hosts as STAGING_HTTP_INGRESS_HOSTS };
