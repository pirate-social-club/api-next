import { Schema } from "effect";
import {
  type CloudflareAccessJwtFetch,
  makeCloudflareAccessJwtValidatorV1,
} from "./cloudflare-access-jwt.ts";

export interface KaraokeResetOperatorBindings {
  readonly API_NEXT_ENV?: string;
  readonly KARAOKE_RESET_ENABLED?: string;
  readonly KARAOKE_RESET_ACCESS_ISSUER?: string;
  readonly KARAOKE_RESET_ACCESS_AUDIENCE?: string;
  readonly KARAOKE_RESET_ACCESS_SUBJECT?: string;
}

/** Reuses Access signature/issuer/audience/time validation; no database or user-ID assertion. */
export async function admitKaraokeResetOperator(
  bindings: KaraokeResetOperatorBindings,
  assertion: string,
  fetchImpl?: CloudflareAccessJwtFetch,
): Promise<void> {
  try {
    if (
      bindings.API_NEXT_ENV !== "staging" ||
      bindings.KARAOKE_RESET_ENABLED !== "true" ||
      !bindings.KARAOKE_RESET_ACCESS_ISSUER ||
      !bindings.KARAOKE_RESET_ACCESS_AUDIENCE ||
      !bindings.KARAOKE_RESET_ACCESS_SUBJECT
    )
      throw new Error("disabled");
    const verifier = makeCloudflareAccessJwtValidatorV1({
      issuer: bindings.KARAOKE_RESET_ACCESS_ISSUER,
      audience: bindings.KARAOKE_RESET_ACCESS_AUDIENCE,
      jwksUrl: `${bindings.KARAOKE_RESET_ACCESS_ISSUER}/cdn-cgi/access/certs`,
      clock: { nowUnixSeconds: () => Math.floor(Date.now() / 1_000) },
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    await verifier.verify(assertion);
    const encoded = assertion.split(".")[1] ?? "";
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const claims = Schema.decodeUnknownSync(Schema.Struct({ sub: Schema.String }))(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
    if (claims.sub !== bindings.KARAOKE_RESET_ACCESS_SUBJECT) throw new Error("wrong-operator");
  } catch {
    throw new Error("karaoke_reset_operator_denied");
  }
}
