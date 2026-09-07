import { createHash } from "node:crypto";
import { readBoundedProviderJson } from "./staging-provider-response.ts";

export const STAGING_PRODUCER_WORKERS = [
  "pirate-http-worker-staging",
  "pirate-jobs-worker-staging",
  "pirate-media-processor-worker-staging",
  "pirate-data-registration-worker-staging",
] as const;

type WorkerName = (typeof STAGING_PRODUCER_WORKERS)[number];
export type ReviewedWorkerVersion = {
  readonly worker: WorkerName;
  readonly versionId: string;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("deployment_response_unproven");
  return value as Record<string, unknown>;
};

function servingDeployment(raw: unknown, pin: ReviewedWorkerVersion, now: number) {
  const envelope = object(raw);
  const deployments = object(envelope.result).deployments;
  if (envelope.success !== true || !Array.isArray(deployments) || deployments.length === 0)
    throw new Error("deployment_missing");
  // Cloudflare returns the deployment actively serving traffic first. An older
  // matching entry is never evidence that the reviewed version is serving now.
  const current = object(deployments[0]);
  const createdAt = typeof current.created_on === "string" ? Date.parse(current.created_on) : NaN;
  if (
    typeof current.id !== "string" ||
    !UUID.test(current.id) ||
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    current.strategy !== "percentage" ||
    !Array.isArray(current.versions) ||
    current.versions.length !== 1
  )
    throw new Error("deployment_shape_unproven");
  const version = object(current.versions[0]);
  if (version.percentage !== 100 || version.version_id !== pin.versionId)
    throw new Error("deployment_reviewed_version_not_serving");
  return { worker: pin.worker, deploymentId: current.id, versionId: pin.versionId, createdAt };
}

/** Pins come from the independently reviewed release receipt, never this API's inventory.
 * This observation does not prove queue drain, producer fencing or reset admission.
 */
export async function collectStagingWorkerDeployments(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly reviewedVersions: readonly ReviewedWorkerVersion[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  if (!/^[a-f0-9]{32}$/u.test(input.accountId) || input.apiToken.length === 0)
    throw new Error("deployment_configuration_invalid");
  if (
    input.reviewedVersions.length !== STAGING_PRODUCER_WORKERS.length ||
    new Set(input.reviewedVersions.map((pin) => pin.worker)).size !==
      STAGING_PRODUCER_WORKERS.length ||
    input.reviewedVersions.some(
      (pin) => !STAGING_PRODUCER_WORKERS.includes(pin.worker) || !UUID.test(pin.versionId),
    )
  )
    throw new Error("deployment_reviewed_pins_incomplete");
  const pins = STAGING_PRODUCER_WORKERS.map((worker) => {
    const pin = input.reviewedVersions.find((value) => value.worker === worker);
    if (pin === undefined) throw new Error("deployment_reviewed_pins_incomplete");
    return { ...pin };
  });
  const now = input.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = input.fetch ?? globalThis.fetch;
  try {
    return await Promise.race([
      (async () => {
        const scan = async () => {
          const observations = [];
          for (const pin of pins) {
            controller.signal.throwIfAborted();
            const response = await transport(
              `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${pin.worker}/deployments`,
              {
                method: "GET",
                redirect: "manual",
                signal: controller.signal,
                headers: { authorization: `Bearer ${input.apiToken}`, accept: "application/json" },
              },
            );
            observations.push(
              servingDeployment(await readBoundedProviderJson(response, 262_144), pin, now()),
            );
          }
          return observations;
        };
        const first = await scan();
        const second = await scan();
        const verifiedAt = now();
        if (
          JSON.stringify(first) !== JSON.stringify(second) ||
          verifiedAt < startedAt ||
          verifiedAt - startedAt > 15_000
        )
          throw new Error("deployment_observation_changed");
        return {
          executionAuthorized: false as const,
          verifiedAt: new Date(verifiedAt).toISOString(),
          deployments: second,
          observationDigest: createHash("sha256").update(JSON.stringify(second)).digest("hex"),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("deployment_observation_timeout"));
        }, 15_000);
      }),
    ]);
  } catch {
    // Provider errors can contain credentials or response bodies. Never retain them.
    throw new Error("staging_deployment_observation_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
