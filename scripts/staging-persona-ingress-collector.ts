import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  STAGING_HTTP_INGRESS_HOSTS,
  STAGING_HTTP_WORKER_ID,
} from "./staging-persona-ingress-fence.ts";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{32,36}$/u));
const Destination = Schema.Struct({
  type: Schema.Literals(["public", "private", "worker", "preview_worker", "all_workers"]),
  worker_id: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
});
const Application = Schema.Struct({
  id: Id,
  type: Schema.String,
  domain: Schema.optional(Schema.String),
  self_hosted_domains: Schema.optional(Schema.Array(Schema.String)),
  destinations: Schema.optional(Schema.Array(Destination)),
});
const Policy = Schema.Struct({
  id: Id,
  decision: Schema.String,
  include: Schema.Array(Schema.Unknown),
  exclude: Schema.optional(Schema.Array(Schema.Unknown)),
  require: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] => Schema.decodeUnknownSync(schema)(value);
const Envelope = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Unknown),
  result_info: Schema.Struct({ page: Schema.Number, total_pages: Schema.Number }),
});

function matchingHostname(pattern: string): boolean {
  const host = pattern.toLowerCase().split("/", 1)[0] ?? "";
  if (host.includes(":") || host.includes("\\")) throw new Error("ingress_destination_unproven");
  const expression = new RegExp(
    `^${host
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );
  return STAGING_HTTP_INGRESS_HOSTS.some((value) => expression.test(value));
}

/** Inspect provider applications, not operator-authored normalized flags. */
export function selectStagingIngressApplication(raw: readonly unknown[], expectedId: string) {
  const apps = raw.map((value) => decode(Application, value));
  if (new Set(apps.map((app) => app.id)).size !== apps.length)
    throw new Error("ingress_duplicate_application");
  let selected: typeof Application.Type | undefined;
  for (const app of apps) {
    const destinations = app.destinations ?? [];
    const worker = destinations.filter(
      (d) => d.type === "worker" && d.worker_id === STAGING_HTTP_WORKER_ID,
    );
    if (worker.length > 0) {
      if (
        selected !== undefined ||
        worker.length !== 1 ||
        destinations.length !== 1 ||
        app.type !== "self_hosted" ||
        app.id !== expectedId
      )
        throw new Error("ingress_worker_application_ambiguous");
      selected = app;
    }
    if (
      destinations.some(
        (d) => d.type === "preview_worker" && d.worker_id === STAGING_HTTP_WORKER_ID,
      )
    ) {
      throw new Error("ingress_preview_override");
    }
    const publicHosts = [
      ...destinations
        .filter((d) => d.type === "public")
        .map((d) => {
          if (d.uri === undefined) throw new Error("ingress_destination_unproven");
          return d.uri;
        }),
      app.domain,
      ...(app.self_hosted_domains ?? []),
    ].filter((value): value is string => value !== undefined);
    if (publicHosts.some(matchingHostname)) throw new Error("ingress_hostname_override");
  }
  if (selected === undefined) throw new Error("ingress_worker_application_missing");
  return selected;
}

export function verifyStagingIngressBlockPolicies(raw: readonly unknown[]) {
  const policies = raw.map((value) => decode(Policy, value));
  // A block-everyone policy with no conditions cannot admit a human or machine.
  // Refuse mixed policies rather than infer precedence from partial provider data.
  if (
    policies.length !== 1 ||
    policies[0]?.decision !== "deny" ||
    policies[0].include.length !== 1 ||
    JSON.stringify(policies[0].include[0]) !== '{"everyone":{}}' ||
    (policies[0].exclude?.length ?? 0) !== 0 ||
    (policies[0].require?.length ?? 0) !== 0
  ) {
    throw new Error("ingress_block_policy_unproven");
  }
  return policies[0];
}

async function boundedJson(response: Response) {
  if (response.status !== 200 || response.body === null)
    throw new Error("ingress_provider_response");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(2_097_152);
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (count + next.value.byteLength > bytes.length) throw new Error("ingress_provider_size");
      bytes.set(next.value, count);
      count += next.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Read-only provider inventory and unauthenticated probes. Does not install a fence. */
export async function collectStagingIngressFence(input: {
  readonly accountId: string;
  readonly applicationId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}) {
  decode(Id, input.accountId);
  decode(Id, input.applicationId);
  if (input.apiToken.length === 0) throw new Error("ingress_credentials_missing");
  const transport = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const list = async (suffix: string) => {
          const result: unknown[] = [];
          for (let page = 1; page <= 20; page++) {
            const response = await transport(
              `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/access/apps${suffix}?page=${page}&per_page=100`,
              {
                method: "GET",
                redirect: "manual",
                headers: { authorization: `Bearer ${input.apiToken}`, accept: "application/json" },
                signal: controller.signal,
              },
            );
            const envelope = decode(Envelope, await boundedJson(response));
            const total = envelope.result_info.total_pages;
            if (
              envelope.result_info.page !== page ||
              !Number.isSafeInteger(total) ||
              total < 1 ||
              total > 20
            )
              throw new Error("ingress_pagination_unproven");
            result.push(...envelope.result);
            if (page === total) return result;
          }
          throw new Error("ingress_inventory_incomplete");
        };
        const first = selectStagingIngressApplication(await list(""), input.applicationId);
        const policy = verifyStagingIngressBlockPolicies(
          await list(`/${input.applicationId}/policies`),
        );
        const probes = [];
        for (const host of STAGING_HTTP_INGRESS_HOSTS) {
          const response = await transport(`https://${host}/`, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
          void response.body?.cancel().catch(() => undefined);
          if (response.status !== 403) throw new Error("ingress_probe_not_blocked");
          probes.push({ host, status: response.status });
        }
        const last = selectStagingIngressApplication(await list(""), input.applicationId);
        const lastPolicy = verifyStagingIngressBlockPolicies(
          await list(`/${input.applicationId}/policies`),
        );
        if (
          JSON.stringify(first) !== JSON.stringify(last) ||
          JSON.stringify(policy) !== JSON.stringify(lastPolicy)
        )
          throw new Error("ingress_policy_changed");
        return {
          verifiedAt: new Date((input.now ?? Date.now)()).toISOString(),
          workerId: STAGING_HTTP_WORKER_ID,
          applicationId: input.applicationId,
          ingressDenied: true as const,
          probes,
          providerEvidenceDigest: createHash("sha256")
            .update(JSON.stringify({ application: last, policy: lastPolicy, probes }))
            .digest("hex"),
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("ingress_collection_timeout"));
        }, 15_000);
      }),
    ]);
  } catch {
    throw new Error("staging_ingress_fence_unproven");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 3 || Bun.argv[2] !== "--read-only") throw new Error();
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const applicationId = process.env.STAGING_INGRESS_ACCESS_APPLICATION_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !applicationId || !apiToken) throw new Error();
    console.log(
      JSON.stringify(await collectStagingIngressFence({ accountId, applicationId, apiToken })),
    );
  } catch {
    console.error("staging_ingress_fence_unproven");
    process.exitCode = 1;
  }
}
