import { describe, expect, test } from "bun:test";

import {
  handleMegapotPublicCommitment,
  type MegapotPublicCommitmentBucket,
} from "./megapot-commitment-public";

const id = `megapot_commitment_${"a".repeat(64)}`;
const path = `/megapot/commitments/${id}.json`;

function bucketWith(value: string | null): MegapotPublicCommitmentBucket {
  return {
    get: async (key) => {
      expect(key).toBe(`megapot/commitments/${id}.json`);
      return value === null
        ? null
        : {
            body: new Response(value).body as ReadableStream,
            httpEtag: '"commitment-etag"',
          };
    },
  };
}

describe("public Megapot commitment evidence", () => {
  test("serves an exact immutable commitment object", async () => {
    const response = await handleMegapotPublicCommitment(
      new Request(`https://jobs.example${path}`),
      bucketWith('{"domain":"pirate.megapot-commitment-publication.v1"}'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("etag")).toBe('"commitment-etag"');
    expect(await response.json()).toEqual({ domain: "pirate.megapot-commitment-publication.v1" });
  });

  test("supports HEAD without returning the object body", async () => {
    const response = await handleMegapotPublicCommitment(
      new Request(`https://jobs.example${path}`, { method: "HEAD" }),
      bucketWith("must-not-be-returned"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("fails closed for unknown keys, queries, methods, and missing bindings", async () => {
    expect(
      (await handleMegapotPublicCommitment(new Request("https://jobs.example/"), undefined)).status,
    ).toBe(404);
    expect(
      (
        await handleMegapotPublicCommitment(
          new Request(`https://jobs.example${path}?source=browser`),
          bucketWith("unused"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleMegapotPublicCommitment(
          new Request(`https://jobs.example${path}`, { method: "POST" }),
          bucketWith("unused"),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleMegapotPublicCommitment(
          new Request(`https://jobs.example${path}`),
          bucketWith(null),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handleMegapotPublicCommitment(new Request(`https://jobs.example${path}`), undefined))
        .status,
    ).toBe(404);
  });
});
