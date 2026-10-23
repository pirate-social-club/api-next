import { describe, expect, test } from "bun:test";
import {
  type MegapotCommitmentBucket,
  makeR2MegapotCommitmentPublisher,
} from "./megapot-commitment-r2.ts";

const request = {
  idempotencyKey: `megapot_commitment_${"a".repeat(64)}`,
  payload: '{"snapshot":true}',
  payloadHash: "b".repeat(64),
  signingKeyId: "eip191:84532:0x1111111111111111111111111111111111111111",
  signature: `0x${"c".repeat(130)}`,
};

function bucketFixture(existing?: string) {
  const uploaded = new Date("2026-08-26T12:00:00.000Z");
  let body = existing;
  let writes = 0;
  const bucket: MegapotCommitmentBucket = {
    put: async (_key, value, options) => {
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: "*" });
      if (body !== undefined) return null;
      body = value;
      writes += 1;
      return { uploaded };
    },
    get: async () =>
      body === undefined
        ? null
        : {
            uploaded,
            text: async () => body ?? "",
          },
  };
  return { bucket, body: () => body, writes: () => writes };
}

describe("R2 Megapot commitment publisher", () => {
  test("creates one immutable public object and uses its R2 upload timestamp", async () => {
    const fixture = bucketFixture();
    const publisher = makeR2MegapotCommitmentPublisher({
      bucket: fixture.bucket,
      publicOrigin: "https://api-next-staging.pirate.sc",
    });
    const result = await publisher.publish(request);
    expect(result).toEqual({
      publicReference: `https://api-next-staging.pirate.sc/megapot/commitments/${request.idempotencyKey}.json`,
      publishedAt: "2026-08-26T12:00:00.000Z",
    });
    expect(fixture.writes()).toBe(1);
    expect(fixture.body()).toContain("pirate.megapot-commitment-publication.v1");
  });

  test("accepts an exact replay without overwriting the original object", async () => {
    const initial = bucketFixture();
    const first = makeR2MegapotCommitmentPublisher({
      bucket: initial.bucket,
      publicOrigin: "https://api-next-staging.pirate.sc",
    });
    await first.publish(request);
    const replay = bucketFixture(initial.body());
    const result = await makeR2MegapotCommitmentPublisher({
      bucket: replay.bucket,
      publicOrigin: "https://api-next-staging.pirate.sc",
    }).publish(request);
    expect(result.publishedAt).toBe("2026-08-26T12:00:00.000Z");
    expect(replay.writes()).toBe(0);
  });

  test("rejects a same-key payload conflict", async () => {
    const fixture = bucketFixture("different");
    await expect(
      makeR2MegapotCommitmentPublisher({
        bucket: fixture.bucket,
        publicOrigin: "https://api-next-staging.pirate.sc",
      }).publish(request),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  test("publishes an owner-Safe commitment unsigned and says so", async () => {
    const fixture = bucketFixture();
    await makeR2MegapotCommitmentPublisher({
      bucket: fixture.bucket,
      publicOrigin: "https://api-next-staging.pirate.sc",
    }).publish({ ...request, signingKeyId: "unsigned_owner_safe_v1", signature: null });
    expect(JSON.parse(fixture.body() ?? "")).toMatchObject({
      signingKeyId: "unsigned_owner_safe_v1",
      signature: null,
    });
  });

  test("refuses a missing signature on a signing key and a signature on the unsigned key", async () => {
    for (const mismatch of [
      { signingKeyId: request.signingKeyId, signature: null },
      { signingKeyId: "unsigned_owner_safe_v1", signature: request.signature },
    ]) {
      const fixture = bucketFixture();
      await expect(
        makeR2MegapotCommitmentPublisher({
          bucket: fixture.bucket,
          publicOrigin: "https://api-next-staging.pirate.sc",
        }).publish({ ...request, ...mismatch }),
      ).rejects.toMatchObject({ reason: "invalid-request" });
      expect(fixture.writes()).toBe(0);
    }
  });
});
