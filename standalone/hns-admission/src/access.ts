import { Clock, Effect, Layer, Schema } from "effect";
import { verifyTypedData, type Hex } from "viem";
import { HttpAccess } from "./http.ts";
import { AdmissionError } from "./service.ts";
import { Binding, bindingDigest, Seconds } from "./protocol.ts";
import { Address, Hash, toHex } from "./records.ts";
export const AccessProfile = Schema.Struct({
  network: Schema.Literals(["main", "regtest"]),
  tld: Schema.String,
  chainId: Schema.Int,
  registry: Address,
  wrapper: Address,
  controller: Address,
  communityId: Hash,
  sourceSha256: Hash,
});
export type AccessProfile = typeof AccessProfile.Type;
const Authorization = Schema.Struct({
  actor: Address,
  nonce: Hash,
  issuedAt: Seconds,
  deadline: Seconds,
  signature: Schema.String.check(Schema.isPattern(/^0x[0-9a-f]{130}$/)),
});
const fields = [
  "network",
  "tld",
  "chainId",
  "registry",
  "wrapper",
  "controller",
  "communityId",
  "sourceSha256",
] as const;
export const accessTypes = {
  ApiRequest: [
    { name: "bindingDigest", type: "bytes32" },
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "bodyDigest", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
export async function accessData(
  binding: Binding,
  method: string,
  path: string,
  body: string,
  nonce: string,
  issuedAt: number,
  deadline: number,
) {
  const bytes = new TextEncoder().encode(body);
  return {
    domain: {
      name: "PirateNamespaceHttp",
      version: "1",
      chainId: binding.chainId,
      verifyingContract: binding.wrapper as Hex,
    },
    primaryType: "ApiRequest" as const,
    types: accessTypes,
    message: {
      bindingDigest: bindingDigest(binding),
      method,
      path,
      bodyDigest: toHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ) as Hex,
      nonce: nonce as Hex,
      issuedAt: BigInt(issuedAt),
      deadline: BigInt(deadline),
    },
  };
}
export function accessLayer(
  profiles: readonly AccessProfile[],
  publicationEnabled = false,
) {
  const allowed = profiles.map((p) =>
    Schema.decodeUnknownSync(AccessProfile)(p, { onExcessProperty: "error" }),
  );
  return Layer.succeed(
    HttpAccess,
    HttpAccess.of({
      authorize: Effect.fn("Admission.authorize")(
        function* (request, binding, body) {
          if (!allowed.some((p) => fields.every((k) => p[k] === binding[k])))
            return yield* new AdmissionError({ reason: "not_allowlisted" });
          const url = new URL(request.url);
          if (url.search)
            return yield* new AdmissionError({ reason: "invalid_request" });
          const creating =
            request.method === "POST" && url.pathname === "/v1/ceremonies";
          const publishing =
            request.method === "POST" && url.pathname.endsWith("/consent");
          if (binding.network === "main" && publishing && !publicationEnabled)
            return yield* new AdmissionError({
              reason: "publication_not_enabled",
            });
          const value = yield* Schema.decodeUnknownEffect(Authorization)({
            actor: request.headers.get("x-pirate-actor"),
            nonce: request.headers.get("x-pirate-nonce"),
            issuedAt: Number(request.headers.get("x-pirate-issued-at")),
            deadline: Number(request.headers.get("x-pirate-deadline")),
            signature: request.headers.get("x-pirate-signature"),
          }).pipe(
            Effect.mapError(
              () => new AdmissionError({ reason: "invalid_signature" }),
            ),
          );
          const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          if (
            value.issuedAt > now ||
            now - value.issuedAt > 300 ||
            value.deadline <= now ||
            value.deadline > value.issuedAt + 300
          )
            return yield* new AdmissionError({
              reason: "authorization_expired",
            });
          if (
            value.actor !== binding.controller &&
            (creating || value.actor !== binding.installationKey)
          )
            return yield* new AdmissionError({ reason: "invalid_signature" });
          const data = yield* Effect.tryPromise({
            try: () =>
              accessData(
                binding,
                request.method,
                url.pathname,
                body,
                value.nonce,
                value.issuedAt,
                value.deadline,
              ),
            catch: () => new AdmissionError({ reason: "invalid_request" }),
          });
          const valid = yield* Effect.tryPromise({
            try: () =>
              verifyTypedData({
                ...data,
                address: value.actor as Hex,
                signature: value.signature as Hex,
              }),
            catch: () => new AdmissionError({ reason: "invalid_signature" }),
          });
          if (!valid)
            return yield* new AdmissionError({ reason: "invalid_signature" });
        },
      ),
    }),
  );
}
