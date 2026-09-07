import { Schema } from "effect";
import { readBoundedProviderJson } from "./staging-provider-response.ts";

const Envelope = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Unknown,
  result_info: Schema.optional(Schema.Struct({ page: Schema.Int, total_pages: Schema.Int })),
});

/** One authenticated request, bounded through body consumption. No redirects,
 * retries, error-body logging, or caller-selected origin. A lost response is
 * an error even if the provider might have applied the request. */
export function makeKaraokeReleaseHttp(input: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof globalThis.fetch;
}) {
  if (input.accountId !== "08a4c22cf52e2ecae883e36f80a33f4a" || !input.apiToken)
    throw new Error("karaoke_release_transport_scope_denied");
  const transport = input.fetch ?? globalThis.fetch;
  const { accountId, apiToken } = input;
  const request = async (
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    body?: unknown,
  ) => {
    if (!/^\/(?:queues|workers\/scripts|access\/apps)(?:[/?][a-zA-Z0-9/?=&_-]+)$/u.test(path))
      throw new Error("karaoke_release_transport_path_denied");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await transport(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
            {
              method,
              redirect: "manual",
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${apiToken}`,
                accept: "application/json",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          return Schema.decodeUnknownSync(Envelope)(
            await readBoundedProviderJson(response, 262_144),
          );
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("karaoke_release_transport_timeout"));
          }, 15_000);
        }),
      ]);
    } catch {
      throw new Error("karaoke_release_provider_response_unproven");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
  return Object.assign(
    async (path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown) =>
      (await request(path, method, body)).result,
    {
      async list(path: string) {
        const records: unknown[] = [];
        let total: number | undefined;
        for (let page = 1; page <= 20; page++) {
          const envelope = await request(`${path}?page=${page}&per_page=100`, "GET");
          const info = envelope.result_info;
          if (
            !info ||
            info.page !== page ||
            info.total_pages < 1 ||
            info.total_pages > 20 ||
            (total !== undefined && info.total_pages !== total)
          )
            throw new Error("karaoke_release_inventory_incomplete");
          total = info.total_pages;
          records.push(...Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(envelope.result));
          if (page === total) return records;
        }
        throw new Error("karaoke_release_inventory_incomplete");
      },
    },
  );
}
