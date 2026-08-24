import {
  encodeHnsActiveLeaseRenewalRequest,
  HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_MAX_BYTES,
  type HnsActiveLeaseRenewalAuthorityV1,
  type HnsOwnerActiveLeaseRenewalRequestV1,
} from "@pirate/application/namespace-ownership";
import { Effect, Schema } from "effect";
import {
  discardHnsOwnerServiceBindingResponse,
  type HnsOwnerServiceBinding,
  readBoundedHnsOwnerServiceBindingResponse,
} from "./hns-owner-service-binding.ts";

const RENEWAL_URL = "https://hns-owner.internal/internal/hns-owner/v1/active-lease-renewal";
const ERROR_RESPONSE_MAX_BYTES = 64;
const MISCONFIGURED_ERROR_BODY = '{"error":"provider_misconfigured"}';
const INVALID_RESPONSE_ERROR_BODY = '{"error":"invalid_response"}';
const INELIGIBLE_ERROR_BODY = '{"error":"renewal_evidence_ineligible"}';

export const HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS = 12_000;

export class HnsOwnerActiveLeaseRenewalProviderFailed extends Schema.TaggedError<HnsOwnerActiveLeaseRenewalProviderFailed>()(
  "HnsOwnerActiveLeaseRenewalProviderFailed",
  {
    reason: Schema.Literals([
      "unavailable",
      "misconfigured",
      "invalid_response",
      "renewal_evidence_ineligible",
    ]),
  },
) {}

export type HnsOwnerActiveLeaseRenewalServiceBindingProvider = Readonly<{
  readonly renew: (
    request: HnsOwnerActiveLeaseRenewalRequestV1,
    authority: HnsActiveLeaseRenewalAuthorityV1,
    options: Readonly<{ readonly deadline_ms: number; readonly observation_id: string }>,
  ) => Effect.Effect<Uint8Array, HnsOwnerActiveLeaseRenewalProviderFailed>;
}>;

function failed(
  reason: "unavailable" | "misconfigured" | "invalid_response" | "renewal_evidence_ineligible",
): HnsOwnerActiveLeaseRenewalProviderFailed {
  return new HnsOwnerActiveLeaseRenewalProviderFailed({ reason });
}

function canonicalIdentifier(value: string): boolean {
  if (value.length === 0 || value.trim() !== value) return false;
  if (new TextEncoder().encode(value).byteLength > 256) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x20 && !(point >= 0x7f && point <= 0x9f);
  });
}

async function exactErrorBody(response: Response): Promise<string | null> {
  if (response.headers.get("content-type")?.toLowerCase() !== "application/json") {
    await discardHnsOwnerServiceBindingResponse(response);
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedHnsOwnerServiceBindingResponse(
      response,
      ERROR_RESPONSE_MAX_BYTES,
      () => failed("invalid_response"),
    );
  } catch {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function mappedResponse(response: Response): Promise<Uint8Array> {
  if (response.status === 409) {
    const body = await exactErrorBody(response);
    if (body === INELIGIBLE_ERROR_BODY) throw failed("renewal_evidence_ineligible");
    throw failed("invalid_response");
  }
  if (response.status === 502) {
    const body = await exactErrorBody(response);
    if (body === MISCONFIGURED_ERROR_BODY) throw failed("misconfigured");
    if (body === INVALID_RESPONSE_ERROR_BODY) throw failed("invalid_response");
    throw failed("invalid_response");
  }
  if (response.status === 429 || response.status >= 500) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("unavailable");
  }
  if ([400, 404, 422].includes(response.status)) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("invalid_response");
  }
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.toLowerCase() !== "application/octet-stream"
  ) {
    await discardHnsOwnerServiceBindingResponse(response);
    throw failed("invalid_response");
  }
  return readBoundedHnsOwnerServiceBindingResponse(
    response,
    HNS_ACTIVE_LEASE_RENEWAL_RESPONSE_MAX_BYTES,
    () => failed("invalid_response"),
  );
}

export function makeHnsOwnerActiveLeaseRenewalServiceBindingProvider(
  binding: HnsOwnerServiceBinding,
): HnsOwnerActiveLeaseRenewalServiceBindingProvider {
  return {
    renew: (request, authority, options) => {
      if (
        options.deadline_ms !== HNS_OWNER_ACTIVE_LEASE_RENEWAL_DEADLINE_MS ||
        !canonicalIdentifier(options.observation_id)
      ) {
        return Effect.fail(failed("misconfigured"));
      }
      return Effect.tryPromise({
        try: () => encodeHnsActiveLeaseRenewalRequest(request, authority),
        catch: () => failed("invalid_response"),
      }).pipe(
        Effect.flatMap((body) =>
          Effect.tryPromise({
            try: async () => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), options.deadline_ms);
              try {
                const response = await binding.fetch(RENEWAL_URL, {
                  method: "POST",
                  headers: [
                    ["Content-Type", "application/json"],
                    ["Accept", "application/octet-stream"],
                    ["Pirate-HNS-Active-Lease-Renewal-Id", request.active_lease_renewal_id],
                    ["Pirate-HNS-Observation-Id", options.observation_id],
                  ],
                  body,
                  redirect: "manual",
                  signal: controller.signal,
                });
                return await mappedResponse(response);
              } finally {
                clearTimeout(timeout);
              }
            },
            catch: (error) =>
              error instanceof HnsOwnerActiveLeaseRenewalProviderFailed
                ? error
                : failed("unavailable"),
          }),
        ),
      );
    },
  };
}
