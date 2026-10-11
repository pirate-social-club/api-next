import { expect, test } from "bun:test";
import { verifyCommitmentReader } from "./commitment-reader.mjs";
import { isolatedCommitmentOrigin } from "./worker-plan.mjs";

const jobs = {
  resources: {
    bindings: [
      { name: "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN", text: isolatedCommitmentOrigin },
      { name: "MEGAPOT_COMMITMENTS", bucket_name: "pirate-megapot-commitments-e2e-staging" },
    ],
  },
};
const headers = { etag: '"9ea1063107df82c0a9416b332467975d"', "content-type": "application/json" };

test("reader preparation uses only HEAD on the existing pinned public document", async () => {
  const result = await verifyCommitmentReader(jobs, async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe(isolatedCommitmentOrigin);
    expect(init.method).toBe("HEAD");
    expect(init.redirect).toBe("manual");
    return new Response(null, { status: 200, headers });
  });
  expect(result.status).toBe(200);
});

test("wrong origin or bucket refuses before any request", async () => {
  for (const index of [0, 1]) {
    const changed = structuredClone(jobs);
    const binding = changed.resources.bindings[index];
    if (!binding) throw Error("Missing test binding");
    Object.assign(
      binding,
      index === 0 ? { text: "https://shared.example" } : { bucket_name: "shared" },
    );
    let requests = 0;
    await expect(
      verifyCommitmentReader(changed, async () => {
        requests++;
        return new Response();
      }),
    ).rejects.toThrow("binding differs");
    expect(requests).toBe(0);
  }
});

test("the CDN's weak ETag retains the pinned document identity", async () => {
  const result = await verifyCommitmentReader(
    jobs,
    async () =>
      new Response(null, { status: 200, headers: { ...headers, etag: `W/${headers.etag}` } }),
  );
  expect(result.status).toBe(200);
});

test("redirected, missing or changed public evidence refuses without retry", async () => {
  for (const candidate of [
    { status: 302, headers },
    { status: 404, headers },
    { status: 200, headers: { ...headers, etag: '"changed"' } },
    { status: 200, headers: { ...headers, "content-type": "text/html" } },
  ]) {
    let requests = 0;
    await expect(
      verifyCommitmentReader(jobs, async () => {
        requests++;
        return new Response(null, candidate);
      }),
    ).rejects.toThrow("probe refused");
    expect(requests).toBe(1);
  }
});
