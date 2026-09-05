import { VIDEO_PLAYBACK_ACCESS_POLICY } from "@pirate/application/video/playback-access";
import { Effect } from "effect";

const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

/** The key must be imported from deployment secrets, never supplied by a request. */
export function makeVideoPlaybackSigner(options: {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly nowSeconds: () => number;
}) {
  const algorithm = options.privateKey.algorithm as {
    readonly name: string;
    readonly hash?: { readonly name: string };
    readonly modulusLength?: number;
  };
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(options.keyId) ||
    options.privateKey.type !== "private" ||
    !options.privateKey.usages.includes("sign") ||
    algorithm.name !== "RSASSA-PKCS1-v1_5" ||
    algorithm.hash?.name !== "SHA-256" ||
    (algorithm.modulusLength ?? 0) < 2048
  ) {
    throw new Error("Invalid playback signing configuration");
  }
  return (input: Readonly<{ providerVideoId: string; expiresAtSeconds: number }>) =>
    Effect.tryPromise({
      try: async () => {
        const now = options.nowSeconds();
        if (
          !/^[A-Za-z0-9_-]{1,128}$/u.test(input.providerVideoId) ||
          !Number.isSafeInteger(now) ||
          now < 0 ||
          !Number.isSafeInteger(input.expiresAtSeconds) ||
          input.expiresAtSeconds <= now ||
          input.expiresAtSeconds - now > VIDEO_PLAYBACK_ACCESS_POLICY.lifetimeSeconds
        ) {
          throw new Error("Invalid playback signing input");
        }
        const message = `${json({ alg: "RS256", kid: options.keyId })}.${json({
          sub: input.providerVideoId,
          kid: options.keyId,
          exp: input.expiresAtSeconds,
        })}`;
        const signature = await crypto.subtle.sign(
          "RSASSA-PKCS1-v1_5",
          options.privateKey,
          new TextEncoder().encode(message),
        );
        return `${message}.${encode(new Uint8Array(signature))}`;
      },
      catch: () => new Error("Playback signing unavailable"),
    });
}
