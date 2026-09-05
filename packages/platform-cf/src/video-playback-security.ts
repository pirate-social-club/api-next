import { Schema } from "effect";
import {
  makeVideoPlaybackRateLimiter,
  type VideoRateNamespace,
} from "./video-playback-rate-limiter.ts";
import { makeVideoPlaybackSigner } from "./video-playback-signer.ts";

const PrivateRsaJwk = Schema.Struct({
  kty: Schema.Literal("RSA"),
  n: Schema.String,
  e: Schema.String,
  d: Schema.String,
  p: Schema.String,
  q: Schema.String,
  dp: Schema.String,
  dq: Schema.String,
  qi: Schema.String,
  kid: Schema.optional(Schema.String),
});
const required = (name: string, value: string | undefined): string => {
  if (!value || value.trim() !== value) throw new Error(`${name} binding is required`);
  return value;
};
const decode = (value: string, maximum: number): Uint8Array<ArrayBuffer> => {
  if (value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value))
    throw new Error("Invalid encoded key");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
};

/** Await at composition: no partial signer/limiter is returned on missing bindings. */
export async function loadVideoPlaybackSecurity(deployment: {
  readonly customerHost?: string;
  readonly signingKeyId?: string;
  readonly signingJwkBase64?: string;
  readonly sourceHmacBase64?: string;
  readonly namespace?: VideoRateNamespace;
  readonly nowSeconds: () => number;
}) {
  const customerHost = required("VIDEO_STREAM_CUSTOMER_HOST", deployment.customerHost);
  const keyId = required("VIDEO_STREAM_SIGNING_KEY_ID", deployment.signingKeyId);
  const encodedJwk = required("VIDEO_STREAM_SIGNING_JWK_BASE64", deployment.signingJwkBase64);
  const encodedHmac = required("VIDEO_PLAYBACK_SOURCE_HMAC_BASE64", deployment.sourceHmacBase64);
  if (!deployment.namespace || typeof deployment.namespace.getByName !== "function")
    throw new Error("VIDEO_PLAYBACK_RATE_LIMITER binding is required");
  if (!/^customer-[a-z0-9]+\.cloudflarestream\.com$/u.test(customerHost))
    throw new Error("VIDEO_STREAM_CUSTOMER_HOST binding is invalid");
  let privateKey: CryptoKey;
  try {
    const jwk = Schema.decodeUnknownSync(PrivateRsaJwk)(
      JSON.parse(new TextDecoder().decode(decode(encodedJwk, 32768))),
    );
    if (jwk.kid !== undefined && jwk.kid !== keyId) throw new Error("Key identifier mismatch");
    privateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("VIDEO_STREAM_SIGNING_JWK_BASE64 binding is invalid");
  }
  let hmacKey: CryptoKey;
  try {
    const bytes = decode(encodedHmac, 128);
    if (bytes.byteLength !== 32) throw new Error("Expected 256-bit HMAC key");
    hmacKey = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("VIDEO_PLAYBACK_SOURCE_HMAC_BASE64 binding is invalid");
  }
  return {
    customerHost,
    sign: makeVideoPlaybackSigner({ keyId, privateKey, nowSeconds: deployment.nowSeconds }),
    limit: makeVideoPlaybackRateLimiter({ namespace: deployment.namespace, hmacKey }),
  };
}
