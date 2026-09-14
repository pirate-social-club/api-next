/** Shared fake for the Cloudflare Access surface the ingress reversal uses.
 * It is a plain module rather than a test-file export so both the ingress
 * suite and the launcher suite can bind the same provider shape. */

export const ACCOUNT = "08a4c22cf52e2ecae883e36f80a33f4a";
export const WORKER_DESTINATION = {
  type: "worker",
  worker_id: "7ada21fbaf794466bae2eda487299555",
};

export type AccessFenceState = {
  readonly apps: { id: string; type: string; destinations: unknown[] }[];
  readonly policies: { id: string; decision: string; include: unknown[] }[];
  creates: number;
  policyCreates: number;
  probeStatus: number;
  /** Simulates a provider that echoes a created application with an extra,
   * unrelated destination so the pre-write validation is exercised. */
  readonly extraDestinationOnCreate?: boolean;
};

export function accessFenceFetch(state: AccessFenceState) {
  const fenceAppId = "f".repeat(32);
  const policyId = "a".repeat(32);
  return (async (raw: string | URL | Request, init?: RequestInit) => {
    const url = String(raw);
    if (
      url === "https://api-next-staging.pirate.sc/" ||
      url === "https://pirate-http-worker-staging.piratesocialclub.workers.dev/"
    )
      return new Response(null, { status: state.probeStatus });
    if (url.includes("/access/apps")) {
      const method = init?.method ?? "GET";
      if (method === "POST" && url.includes("/policies")) {
        state.policyCreates++;
        state.policies.push({
          id: policyId,
          ...(JSON.parse(String(init?.body)) as { decision: string; include: unknown[] }),
        });
        return Response.json({ success: true, result: state.policies.at(-1) });
      }
      if (method === "POST") {
        state.creates++;
        const body = JSON.parse(String(init?.body)) as {
          type: string;
          destinations: unknown[];
        };
        state.apps.push({
          id: fenceAppId,
          ...body,
          destinations:
            state.extraDestinationOnCreate === true
              ? [...body.destinations, { type: "worker", worker_id: "unrelated-worker" }]
              : body.destinations,
        });
        return Response.json({ success: true, result: state.apps.at(-1) });
      }
      if (url.includes("/policies"))
        return Response.json({
          success: true,
          result: state.policies,
          result_info: { page: 1, total_pages: 1 },
        });
      return Response.json({
        success: true,
        result: state.apps,
        result_info: { page: 1, total_pages: 1 },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof globalThis.fetch;
}
