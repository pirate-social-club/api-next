import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeSongPlaybackSigner } from "./song-playback-signer.ts";

const sign = makeSongPlaybackSigner({
  accountId: "a".repeat(32),
  bucket: "immutable-fixture",
  accessKeyId: "fixture-access",
  secretAccessKey: "fixture-secret",
});
test("signs only a bounded immutable GET grant without exposing the signing secret", async () => {
  const raw = await Effect.runPromise(
    sign({
      immutableRef: "media://immutable/song/audio",
      nowSeconds: 1788912000,
      lifetimeSeconds: 900,
    }),
  );
  const url = new URL(raw);
  expect(url.origin).toBe(`https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  expect(url.pathname).toBe("/immutable-fixture/immutable/song/audio");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  expect(raw).not.toContain("fixture-secret");
  for (const immutableRef of [
    "https://attacker.test/audio",
    "reservations/source",
    "media://immutable/../source",
  ])
    await expect(
      Effect.runPromise(sign({ immutableRef, nowSeconds: 1788912000, lifetimeSeconds: 900 })),
    ).rejects.toThrow();
  await expect(
    Effect.runPromise(
      sign({
        immutableRef: "media://immutable/song/audio",
        nowSeconds: 1788912000,
        lifetimeSeconds: 86400,
      }),
    ),
  ).rejects.toThrow();
});
