import { makeKaraokeReleaseHttp } from "./staging-karaoke-release-http.ts";
import {
  selectStagingIngressApplication,
  verifyStagingIngressBlockPolicies,
} from "./staging-persona-ingress-collector.ts";
import {
  STAGING_HTTP_INGRESS_HOSTS,
  STAGING_HTTP_WORKER_ID,
} from "./staging-persona-ingress-fence.ts";

/** Reviewed live staging Cloudflare account. */
export const STAGING_LIVE_CLOUDFLARE_ACCOUNT_ID = "08a4c22cf52e2ecae883e36f80a33f4a";

/** The reviewed fence application and policy bodies. They are fixed by source
 * (the worker id is the reviewed HTTP Worker; the denial shape is exactly what
 * the held-fence collector accepts), which is what makes the reversal a fixed
 * target rather than a reconstruction from whatever survived a partial run. */
export const STAGING_INGRESS_FENCE_APPLICATION_NAME = "staging-http-worker-reset-fence";
export const STAGING_INGRESS_FENCE_POLICY = Object.freeze({
  name: "deny-everyone",
  decision: "deny" as const,
  include: Object.freeze([{ everyone: {} }]),
});

/** The production ingress reversal: recreate the single worker-level
 * deny-everyone Access application and prove it through the same reviewed
 * selectors and unauthenticated probes the held-fence collector uses.
 *
 * `assertAvailable` is read-only and runs before the first mutation, so the
 * launch cannot discover its recovery port is missing only after ingress has
 * opened. `run` is idempotent when the fence is already installed or when an
 * earlier attempt created the application but not its policy, and it refuses a
 * foreign or malformed worker application rather than editing it.
 *
 * The complete target is validated before any write, including inside
 * recovery: the interval between admission and a failure can contain a changed
 * application, so the collector's own selector re-reads and rejects additional
 * destinations, preview overrides and ambiguous bindings before the deny
 * policy is attached. */
export function makeLiveIngressRefence(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Bound for each unauthenticated host probe. Mirrors the held-fence
   * collector's bounded probe: a stalled host cannot hold ingress recovery
   * open and stop the database re-fence that follows it. */
  readonly probeTimeoutMs?: number;
}) {
  if (input.accountId !== STAGING_LIVE_CLOUDFLARE_ACCOUNT_ID || !input.apiToken)
    throw new Error("staging_live_transport_scope_denied");
  const probeTimeoutMs = input.probeTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1)
    throw new Error("staging_live_ingress_refence_unproven");
  const transport = input.fetch ?? globalThis.fetch;
  const http = makeKaraokeReleaseHttp({
    accountId: input.accountId,
    apiToken: input.apiToken,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  const workerApplications = (applications: readonly unknown[]) =>
    applications.filter((application) => {
      const destinations =
        (application as { destinations?: readonly { type?: unknown; worker_id?: unknown }[] })
          .destinations ?? [];
      return destinations.some(
        (destination) =>
          destination.type === "worker" && destination.worker_id === STAGING_HTTP_WORKER_ID,
      );
    });
  const applicationIdOf = (application: unknown): string => {
    const id = (application as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("staging_live_ingress_refence_unproven");
    return id;
  };
  /** The collector's selector is the complete-target check. It rejects a
   * foreign application, extra destinations, preview overrides, hostname
   * overrides and ambiguous worker bindings. Nothing is written until it
   * passes on a fresh read. */
  const assertSelectable = (applications: readonly unknown[], applicationId: string) => {
    try {
      selectStagingIngressApplication(applications, applicationId);
    } catch {
      throw new Error("staging_live_ingress_refence_unproven");
    }
  };
  const verifyPolicy = async (applicationId: string) => {
    try {
      verifyStagingIngressBlockPolicies(await http.list(`/access/apps/${applicationId}/policies`));
    } catch {
      throw new Error("staging_live_ingress_refence_unproven");
    }
  };
  const probeHost = async (host: string): Promise<number> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await transport(`https://${host}/`, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
          void response.body?.cancel().catch(() => undefined);
          return response.status;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("staging_live_ingress_probe_timeout"));
          }, probeTimeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const verifyFence = async (applicationId: string) => {
    assertSelectable(await http.list("/access/apps"), applicationId);
    await verifyPolicy(applicationId);
    for (const host of STAGING_HTTP_INGRESS_HOSTS)
      if ((await probeHost(host)) !== 403) throw new Error("staging_live_ingress_refence_unproven");
  };
  return {
    async assertAvailable(): Promise<void> {
      const existing = workerApplications(await http.list("/access/apps"));
      if (existing.length > 1) throw new Error("staging_live_ingress_refence_unproven");
      if (existing.length === 1) await verifyFence(applicationIdOf(existing[0]));
    },
    async run(): Promise<void> {
      const applications = await http.list("/access/apps");
      const existing = workerApplications(applications);
      if (existing.length > 1) throw new Error("staging_live_ingress_refence_unproven");
      let applicationId: string;
      if (existing.length === 1) {
        applicationId = applicationIdOf(existing[0]);
        // Validate the complete existing target before the first write. A
        // malformed application is refused, never mutated.
        assertSelectable(applications, applicationId);
      } else {
        applicationId = applicationIdOf(
          await http("/access/apps", "POST", {
            name: STAGING_INGRESS_FENCE_APPLICATION_NAME,
            type: "self_hosted",
            destinations: [{ type: "worker", worker_id: STAGING_HTTP_WORKER_ID }],
          }),
        );
        // Re-read and validate the provider's own account of what it created
        // before attaching the policy; a response that does not name exactly
        // this worker-bound application refuses.
        const refreshed = await http.list("/access/apps");
        const bound = workerApplications(refreshed);
        if (bound.length !== 1 || applicationIdOf(bound[0]) !== applicationId)
          throw new Error("staging_live_ingress_refence_unproven");
        assertSelectable(refreshed, applicationId);
      }
      const policies = await http.list(`/access/apps/${applicationId}/policies`);
      if (policies.length === 0)
        await http(`/access/apps/${applicationId}/policies`, "POST", STAGING_INGRESS_FENCE_POLICY);
      await verifyFence(applicationId);
    },
  };
}
