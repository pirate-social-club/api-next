import {
  AddMegapotPoolLeg,
  GetMegapotPoolFunding,
  GetSongMegapotPool,
  ObserveMegapotPoolFunding,
  OpenSongRewardOffer,
} from "@pirate/contracts";
import { Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const AtomicAmount = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const TransactionHash = Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{64}$/u));
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

const GoldenInput = Schema.Struct({
  run_id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/u)),
  community_id: Identifier,
  post_id: Identifier,
  persona_id: Identifier,
  starts_at: CanonicalInstant,
  ends_at: CanonicalInstant,
  funding_amount_atomic: AtomicAmount,
  max_ticket_price_atomic: AtomicAmount,
  entry_cutoff_seconds: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  eligible_activities: Schema.NonEmptyArray(Schema.Literals(["study", "karaoke"])).check(
    Schema.isMaxLength(2),
  ),
  qualification_fixture_acknowledged: Schema.Literal(true),
  funding_transaction_hash: Schema.optional(Schema.NullOr(TransactionHash)),
});

type GoldenInput = Schema.Schema.Type<typeof GoldenInput>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type MegapotGoldenOptions = Readonly<{
  execute: boolean;
  apiOrigin: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
}>;

export type MegapotGoldenDependencies = Readonly<{
  fetcher: Fetcher;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export class MegapotBaseSepoliaGoldenFailed extends Error {
  readonly code: "invalid-auth" | "invalid-input" | "invalid-options" | "request-failed";

  constructor(code: MegapotBaseSepoliaGoldenFailed["code"], message: string) {
    super(message);
    this.name = "MegapotBaseSepoliaGoldenFailed";
    this.code = code;
  }
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      "The staging API returned an invalid rewards contract.",
    );
  }
}

export function parseMegapotGoldenInput(value: unknown): GoldenInput {
  let input: GoldenInput;
  try {
    input = Schema.decodeUnknownSync(GoldenInput, { onExcessProperty: "error" })(value);
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-input",
      "The Base Sepolia golden-flow input is invalid.",
    );
  }
  if (
    Date.parse(input.starts_at) >= Date.parse(input.ends_at) ||
    BigInt(input.funding_amount_atomic) < BigInt(input.max_ticket_price_atomic) ||
    new Set(input.eligible_activities).size !== input.eligible_activities.length
  ) {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-input",
      "The golden flow requires an ordered window, enough funding, and distinct activities.",
    );
  }
  return input;
}

function endpoint(origin: string, path: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "The staging API origin is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api-next-staging.pirate.sc" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "The golden flow is restricted to https://api-next-staging.pirate.sc.",
    );
  }
  return new URL(path, url).toString();
}

function authHeaders(options: MegapotGoldenOptions, write: boolean): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (options.authorization !== undefined) {
    if (
      options.cookie !== undefined ||
      options.csrfToken !== undefined ||
      options.authorization.includes("\n") ||
      !options.authorization.startsWith("Bearer ")
    ) {
      throw new MegapotBaseSepoliaGoldenFailed("invalid-auth", "Staging authorization is invalid.");
    }
    headers.set("authorization", options.authorization);
  } else {
    const cookie = options.cookie;
    const csrf = options.csrfToken;
    if (
      cookie === undefined ||
      csrf === undefined ||
      cookie.includes("\n") ||
      csrf.includes("\n") ||
      !cookie.includes("__Host-pirate_session=") ||
      !cookie.includes(`__Host-pirate_csrf=${csrf}`)
    ) {
      throw new MegapotBaseSepoliaGoldenFailed(
        "invalid-auth",
        "A valid staging session cookie and matching CSRF token are required.",
      );
    }
    headers.set("cookie", cookie);
    headers.set("origin", "https://web-next-staging.pirate.sc");
    if (write) headers.set("x-csrf-token", csrf);
  }
  if (write) headers.set("content-type", "application/json");
  return headers;
}

async function requestJson<S extends Schema.ConstraintDecoder<unknown>>(
  dependencies: MegapotGoldenDependencies,
  options: MegapotGoldenOptions,
  path: string,
  schema: S,
  request?: { readonly method: "POST"; readonly body: unknown },
): Promise<S["Type"]> {
  const response = await dependencies.fetcher(endpoint(options.apiOrigin, path), {
    method: request?.method ?? "GET",
    headers: authHeaders(options, request !== undefined),
    ...(request === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") ?? "missing";
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      `Staging rewards request failed with HTTP ${response.status}; request id ${requestId}.`,
    );
  }
  let document: unknown;
  try {
    document = (await response.json()) as unknown;
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed(
      "request-failed",
      "The staging rewards response was not JSON.",
    );
  }
  return decode(schema, document);
}

function idempotencyKey(input: GoldenInput, step: "offer" | "leg" | "funding"): string {
  return `megapot-golden-${input.run_id}-${step}`;
}

function dryRun(input: GoldenInput) {
  return {
    mode: "dry-run" as const,
    chain_id: 84_532 as const,
    empty_pool_policy: "no_purchase" as const,
    min_score_bps: 7_000 as const,
    qualification_fixture_acknowledged: input.qualification_fixture_acknowledged,
    funding_transaction_supplied: input.funding_transaction_hash != null,
    idempotency_keys: {
      offer: idempotencyKey(input, "offer"),
      leg: idempotencyKey(input, "leg"),
      funding: idempotencyKey(input, "funding"),
    },
  };
}

export async function runMegapotBaseSepoliaGolden(
  input: GoldenInput,
  options: MegapotGoldenOptions,
  dependencies: MegapotGoldenDependencies = {
    fetcher: fetch,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
  },
) {
  const plan = dryRun(input);
  endpoint(options.apiOrigin, "/");
  if (!options.execute) return plan;

  const communityId = encodeURIComponent(input.community_id);
  const postId = encodeURIComponent(input.post_id);
  const opened = await requestJson(
    dependencies,
    options,
    `/communities/${communityId}/posts/${postId}/reward-offers`,
    OpenSongRewardOffer.response,
    {
      method: "POST",
      body: {
        idempotency_key: idempotencyKey(input, "offer"),
        persona_id: input.persona_id,
        starts_at: input.starts_at,
        ends_at: input.ends_at,
      },
    },
  );
  const offerId = encodeURIComponent(opened.offer.offer_id);
  const added = await requestJson(
    dependencies,
    options,
    `/reward-offers/${offerId}/megapot-pool-legs`,
    AddMegapotPoolLeg.response,
    {
      method: "POST",
      body: {
        idempotency_key: idempotencyKey(input, "leg"),
        persona_id: input.persona_id,
        funding_amount_atomic: input.funding_amount_atomic,
        max_ticket_price_atomic: input.max_ticket_price_atomic,
        entry_cutoff_seconds: input.entry_cutoff_seconds,
        eligible_activities: input.eligible_activities,
        min_score_bps: 7_000,
        empty_pool_policy: "no_purchase",
        fallback_payout_persona_id: null,
        fallback_disclosure_acknowledged: false,
      },
    },
  );
  if (input.funding_transaction_hash == null) {
    return {
      ...plan,
      mode: "execute" as const,
      state: "awaiting_funder_transfer" as const,
      offer: opened.offer,
      leg: added.leg,
      funding: added.funding,
    };
  }

  const legId = encodeURIComponent(added.leg.leg_id);
  const fundingId = encodeURIComponent(added.funding.funding_effect_id);
  let observed: Schema.Schema.Type<typeof ObserveMegapotPoolFunding.response> | undefined;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    observed = await requestJson(
      dependencies,
      options,
      `/reward-offer-legs/${legId}/funding/${fundingId}/observations`,
      ObserveMegapotPoolFunding.response,
      {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey(input, "funding"),
          persona_id: input.persona_id,
          transaction_hash: input.funding_transaction_hash,
        },
      },
    );
    if (observed.funding.status === "confirmed") break;
    if (["reverted", "reconciliation_required"].includes(observed.funding.status)) break;
    await dependencies.sleep(5_000);
  }
  if (observed === undefined) {
    throw new MegapotBaseSepoliaGoldenFailed("request-failed", "Funding was not observed.");
  }

  const [funding, pool] = await Promise.all([
    requestJson(
      dependencies,
      options,
      `/reward-offer-legs/${legId}/funding/${fundingId}`,
      GetMegapotPoolFunding.response,
    ),
    requestJson(
      dependencies,
      options,
      `/communities/${communityId}/posts/${postId}/rewards/megapot-pool`,
      GetSongMegapotPool.response,
    ),
  ]);
  return {
    ...plan,
    mode: "execute" as const,
    state:
      funding.funding.status === "confirmed" ? ("funded" as const) : ("funding_pending" as const),
    offer: opened.offer,
    leg: added.leg,
    funding: funding.funding,
    pool: pool.pool,
  };
}

function parseOptions(args: readonly string[]): {
  readonly execute: boolean;
  readonly input: string;
} {
  const execute = args.includes("--execute");
  const confirmed = args.includes("--confirm-base-sepolia");
  const inputIndex = args.indexOf("--input");
  const input = inputIndex < 0 ? undefined : args[inputIndex + 1];
  const allowed = new Set(["--execute", "--confirm-base-sepolia", "--input", input]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (
    unknown !== undefined ||
    input === undefined ||
    input.startsWith("--") ||
    execute !== confirmed
  ) {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "Use --input PATH for dry-run, or add --execute --confirm-base-sepolia together.",
    );
  }
  return { execute, input };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (process.env.API_NEXT_ENV !== "staging") {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "The golden flow is refused unless API_NEXT_ENV=staging.",
    );
  }
  const parsed = parseOptions(args);
  let document: unknown;
  try {
    document = JSON.parse(await Bun.file(parsed.input).text()) as unknown;
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed("invalid-input", "Unable to read golden-flow input.");
  }
  const result = await runMegapotBaseSepoliaGolden(parseMegapotGoldenInput(document), {
    execute: parsed.execute,
    apiOrigin: process.env.PIRATE_API_PUBLIC_ORIGIN ?? "https://api-next-staging.pirate.sc",
    ...(process.env.PIRATE_STAGING_AUTHORIZATION === undefined
      ? {}
      : { authorization: process.env.PIRATE_STAGING_AUTHORIZATION }),
    ...(process.env.PIRATE_STAGING_COOKIE === undefined
      ? {}
      : { cookie: process.env.PIRATE_STAGING_COOKIE }),
    ...(process.env.PIRATE_STAGING_CSRF_TOKEN === undefined
      ? {}
      : { csrfToken: process.env.PIRATE_STAGING_CSRF_TOKEN }),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof MegapotBaseSepoliaGoldenFailed
        ? error.message
        : "Base Sepolia Megapot golden flow failed.",
    );
    process.exitCode = 1;
  });
}
