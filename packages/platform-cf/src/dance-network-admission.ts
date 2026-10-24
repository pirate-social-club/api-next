import { isIP } from "node:net";
import { Effect, Schema } from "effect";
import {
  DanceIntakeDiagnosticCode,
  DanceReviewServiceFailure,
} from "../../application/src/use-cases/dance/moderator-review-services.ts";
import { RateLimited } from "../../contracts/src/errors.ts";

import {
  DANCE_NETWORK_DAY_MS,
  DanceNetworkAdmissionDecision,
  type DanceNetworkAdmissionRequest,
} from "./dance-network-admission-model.ts";
export interface DanceNetworkNamespace {
  readonly getByName: (name: string) => {
    readonly admit: (
      request: typeof DanceNetworkAdmissionRequest.Type,
    ) => Promise<DanceNetworkAdmissionDecision>;
  };
}
export type DanceNetworkAdmission = (
  idempotencyKey: string,
) => Effect.Effect<void, RateLimited | DanceReviewServiceFailure>;
const unavailable = (diagnosticCode: typeof DanceIntakeDiagnosticCode.Type) =>
  new DanceReviewServiceFailure({ reason: "unavailable", diagnosticCode });

/** Lazy by design: committed command recovery must not require a live limiter,
 * address or key. Only the transport-owned edge address reaches this adapter. */
export function makeDanceNetworkAdmission(input: {
  readonly accountId: string;
  readonly edgeClientIp: string | undefined;
  readonly hmacKeyBase64: string | undefined;
  readonly namespace: DanceNetworkNamespace | undefined;
  readonly now?: () => number;
}): DanceNetworkAdmission {
  return (idempotencyKey) => {
    let stage: typeof DanceIntakeDiagnosticCode.Type = "dance_network_identity_invalid";
    return Effect.tryPromise({
      try: async (signal) => {
        const ip = input.edgeClientIp;
        const version = ip === undefined ? 0 : isIP(ip);
        if (!version || !ip) throw unavailable("dance_network_address_unavailable");
        if (!input.namespace) throw unavailable("dance_network_namespace_unavailable");
        if (!input.hmacKeyBase64) throw unavailable("dance_network_hmac_unavailable");
        if (
          !input.accountId ||
          input.accountId.length > 128 ||
          !idempotencyKey ||
          idempotencyKey.length > 128
        )
          throw unavailable("dance_network_identity_invalid");
        stage = "dance_network_hmac_decode";
        const bytes = Uint8Array.from(atob(input.hmacKeyBase64), (char) => char.charCodeAt(0));
        if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== input.hmacKeyBase64)
          throw unavailable(stage);
        stage = "dance_network_hmac_import";
        const key = await crypto.subtle.importKey(
          "raw",
          bytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        signal.throwIfAborted();
        stage = "dance_network_clock_invalid";
        const now = (input.now ?? Date.now)();
        if (!Number.isSafeInteger(now) || now < DANCE_NETWORK_DAY_MS) throw unavailable(stage);
        const day = Math.floor(now / DANCE_NETWORK_DAY_MS);
        const address = version === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
        const digest = async (parts: readonly string[]) => {
          stage = "dance_network_digest";
          const signed = await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(JSON.stringify(parts)),
          );
          signal.throwIfAborted();
          return Array.from(new Uint8Array(signed), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        };
        // Distinct purpose domains from video playback and from one another.
        const network = await digest(["dance-network-bucket-v1", String(day), address]);
        const commandDigest = await digest([
          "dance-network-command-v1",
          input.accountId,
          "create",
          idempotencyKey,
        ]);
        const bucketName = `dance-network-v1:${day}:${network}`;
        signal.throwIfAborted();
        stage = "dance_network_rpc";
        const raw = await input.namespace
          .getByName(bucketName)
          .admit({ bucketName, commandDigest });
        stage = "dance_network_decision_decode";
        const decision = Schema.decodeUnknownSync(DanceNetworkAdmissionDecision, {
          onExcessProperty: "error",
        })(raw);
        signal.throwIfAborted();
        if (!decision.allowed)
          throw new RateLimited({
            message: "This network has reached its daily Dance recording limit",
            retry_after_seconds: decision.retryAfterSeconds,
          });
      },
      catch: (error) =>
        error instanceof RateLimited
          ? error
          : unavailable(
              error instanceof DanceReviewServiceFailure &&
                Schema.is(DanceIntakeDiagnosticCode)(error.diagnosticCode)
                ? error.diagnosticCode
                : stage,
            ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(unavailable("dance_network_deadline")),
      }),
    );
  };
}
