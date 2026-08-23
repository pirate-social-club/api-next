import { describe, expect, test } from "bun:test";

import { parseProbeMode, readStagingConfig, runStagingProbe } from "./r2-seal-probe-staging";
import { cleanupOwnedKeys } from "./r2-seal-probe-staging-cleanup";
import { FakeR2Transport, loadHostileFixtures, probeScenario } from "./r2-seal-probe";
import { redactStagingEvidence } from "./r2-seal-probe-staging-evidence";
import {
  encodeR2CopySource,
  signR2Request,
} from "./r2-seal-probe-staging-signing";
import { R2S3StagingTransport, sha256Base64 } from "./r2-seal-probe-staging-transport";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

function response(status: number, headers?: Record<string, string>, body = ""): Response {
  return new Response(body, { status, headers });
}

describe("staging R2 probe safety", () => {
  test("requires the explicit staging acknowledgement and validates credentials without echoing them", () => {
    expect(parseProbeMode([])).toBe("dry-run");
    expect(parseProbeMode(["--execute-staging"])).toBe("execute-staging");
    expect(() => parseProbeMode(["--execute-staging", SECRET_ACCESS_KEY])).toThrow();
    expect(() =>
      readStagingConfig({
        R2_STAGING_ACCOUNT_ID: ACCOUNT_ID,
        R2_STAGING_ACCESS_KEY_ID: ACCESS_KEY_ID,
        R2_STAGING_SECRET_ACCESS_KEY: "short",
        R2_STAGING_BUCKET: "fixture-bucket",
      }),
    ).toThrow("R2_STAGING_SECRET_ACCESS_KEY");
  });

  test("constructs deterministic SigV4 requests without sending them", async () => {
    const request = await signR2Request({
      accountId: ACCOUNT_ID,
      bucket: "fixture-bucket",
      key: "media/source +.bin",
      method: "HEAD",
      now: new Date("2020-01-01T00:00:00.000Z"),
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
    expect(request.url).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/fixture-bucket/media/source%20%2B.bin",
    );
    expect(request.headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(request.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20200101/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=511da240ef74c6f6b25a7567043466a59cee70457633281e0b2b87b19c92b058",
    );
    expect(request.headers.authorization).not.toContain(SECRET_ACCESS_KEY);
  });

  test("constructs the exact copy headers and parses SHA-256 and VersionId independently of ETag", async () => {
    const bytes = new TextEncoder().encode("fixture");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = new R2S3StagingTransport({
      accountId: ACCOUNT_ID,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
      now: () => new Date("2020-01-01T00:00:00.000Z"),
      fetch: async (url, init) => {
        requests.push({ url, init });
        return response(200, {
          etag: '"multipart-etag-2"',
          "content-length": String(bytes.byteLength),
          "content-type": "audio/mpeg",
          "x-amz-checksum-sha256": await sha256Base64(bytes),
          "x-amz-version-id": "version-1",
        });
      },
    });
    const head = await transport.headObject("fixture-bucket", "source");
    expect(head).toMatchObject({
      kind: "found",
      etag: '"multipart-etag-2"',
      sizeBytes: bytes.byteLength,
      sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
      versionId: "version-1",
    });
    const copy = await transport.copyObject({
      sourceBucket: "fixture-bucket",
      destinationBucket: "fixture-bucket",
      sourceKey: "source path",
      destinationKey: "destination",
      sourceEtag: '"observed-source-etag"',
    });
    expect(copy.kind).toBe("copied");
    const headers = new Headers(requests[1]?.init.headers);
    expect(headers.get("x-amz-copy-source")).toBe(
      encodeR2CopySource("fixture-bucket", "source path"),
    );
    expect(headers.get("x-amz-copy-source-if-match")).toBe('"observed-source-etag"');
    expect(headers.get("cf-copy-destination-if-none-match")).toBe("*");
    const signedHeaders = headers.get("authorization")?.match(/SignedHeaders=([^,]+)/)?.[1] ?? "";
    expect(signedHeaders.split(";")).toEqual(
      expect.arrayContaining([
        "x-amz-copy-source",
        "x-amz-copy-source-if-match",
        "cf-copy-destination-if-none-match",
      ]),
    );
    expect(headers.get("x-amz-checksum-sha256")).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test("treats shared 412 as terminal and performs no destination HEAD or copy retry", async () => {
    const methods: string[] = [];
    let requestNumber = 0;
    const content = new TextEncoder().encode("r2-seal-staging-proof-v1\n");
    const contentChecksum = await sha256Base64(content);
    const fakeFetch = async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? "");
      requestNumber += 1;
      if (requestNumber === 1 || requestNumber === 2) {
        return response(404, {}, "<Error><Code>NoSuchKey</Code></Error>");
      }
      if (requestNumber === 3) return response(200, { etag: '"upload"' });
      if (requestNumber === 4) {
        return response(200, {
          etag: '"source"',
          "content-length": String(content.byteLength),
          "content-type": "audio/mpeg",
          "x-amz-checksum-sha256": contentChecksum,
          "x-amz-version-id": "source-version",
        });
      }
      if (requestNumber === 5) {
        return response(412, {}, "<Error><Code>PreconditionFailed</Code></Error>");
      }
      if (requestNumber === 6) return response(204);
      return response(404, {}, "<Error><Code>NoSuchKey</Code></Error>");
    };
    const evidence = await runStagingProbe({
      env: {
        R2_STAGING_ACCOUNT_ID: ACCOUNT_ID,
        R2_STAGING_ACCESS_KEY_ID: ACCESS_KEY_ID,
        R2_STAGING_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        R2_STAGING_BUCKET: "fixture-bucket",
      },
      fetch: fakeFetch,
      runId: "20260823-160000-test",
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(evidence.sealing.outcome).toBe("conditional_precondition_ambiguous");
    expect(evidence.sealing.automatic_retry).toBe(false);
    expect(evidence.sealing.destination_head).toBeNull();
    expect(evidence.cleanup.keys).toHaveLength(1);
    expect(evidence.cleanup.keys[0]?.absent).toBe(true);
    expect(methods).toEqual(["HEAD", "HEAD", "PUT", "HEAD", "PUT", "DELETE", "HEAD"]);
  });

  test("keeps source-only, destination-only, and combined 412 diagnostics ambiguous", async () => {
    const fixtures = await loadHostileFixtures();
    for (const name of [
      "source-overwritten-before-copy",
      "destination-conflict",
      "simultaneous-source-destination-race",
    ] as const) {
      const fixture = fixtures.scenarios.find((candidate) => candidate.name === name);
      if (fixture === undefined) throw new Error(`${name} fixture missing`);
      const transport = new FakeR2Transport(fixture);
      const evidence = await probeScenario(fixture, transport);
      expect(evidence.outcome).toBe("conditional_precondition_ambiguous");
      expect(evidence.destination_head_calls).toBe(0);
      expect(evidence.conditional_copy_calls).toBe(1);
      expect(evidence.automatic_retry).toBe(false);
      expect(transport.calls.filter((call) => call.kind === "copy")).toHaveLength(1);
    }
  });

  test("cleanup deletes and verifies only exact run-owned keys", async () => {
    const calls: string[] = [];
    const cleanup = await cleanupOwnedKeys(
      {
        async deleteObject(_bucket, key) {
          calls.push(`delete:${key}`);
          return { kind: "deleted", status: 204, code: "OK" };
        },
        async headObject(_bucket, key) {
          calls.push(`head:${key}`);
          return { kind: "missing", status: 404, code: "NoSuchKey" };
        },
      },
      "fixture-bucket",
      "media-r2-seal-probe/run/",
      ["media-r2-seal-probe/run/source.bin"],
    );
    expect(cleanup.status).toBe("complete");
    expect(cleanup.keys[0]?.absent).toBe(true);
    expect(calls).toEqual([
      "delete:media-r2-seal-probe/run/source.bin",
      "head:media-r2-seal-probe/run/source.bin",
    ]);
    await expect(
      cleanupOwnedKeys(
        {
          async deleteObject() {
            throw new Error("must not delete foreign key");
          },
          async headObject() {
            throw new Error("must not inspect foreign key");
          },
        },
        "fixture-bucket",
        "media-r2-seal-probe/run/",
        ["other-prefix/foreign"],
      ),
    ).rejects.toThrow("exact run-owned prefix");
  });

  test("retains a residual key as partial cleanup without widening the delete set", async () => {
    const calls: string[] = [];
    const cleanup = await cleanupOwnedKeys(
      {
        async deleteObject(_bucket, key) {
          calls.push(`delete:${key}`);
          return { kind: "error", status: 503, code: "SlowDown" };
        },
        async headObject(_bucket, key) {
          calls.push(`head:${key}`);
          return { kind: "found", status: 200, code: "OK", etag: '"still-present"' };
        },
      },
      "fixture-bucket",
      "media-r2-seal-probe/run/",
      ["media-r2-seal-probe/run/source.bin"],
    );
    expect(cleanup.status).toBe("partial");
    expect(cleanup.keys).toEqual([
      expect.objectContaining({
        key: "media-r2-seal-probe/run/source.bin",
        absent: false,
      }),
    ]);
    expect(calls).toEqual([
      "delete:media-r2-seal-probe/run/source.bin",
      "head:media-r2-seal-probe/run/source.bin",
    ]);
  });

  test("redacts staging evidence to identities and outcomes only", async () => {
    const env = {
      R2_STAGING_ACCOUNT_ID: ACCOUNT_ID,
      R2_STAGING_ACCESS_KEY_ID: ACCESS_KEY_ID,
      R2_STAGING_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      R2_STAGING_BUCKET: "fixture-bucket",
    };
    const base = await runStagingProbe({
      env,
      fetch: async (_url, init) => {
        if (init.method === "HEAD") return response(404, {}, "<Error><Code>NoSuchKey</Code></Error>");
        return response(412, {}, "<Error><Code>PreconditionFailed</Code></Error>");
      },
      runId: "20260823-160001-test",
    });
    const polluted = {
      ...base,
      request_url: "https://credential.invalid/?signature=must-not-appear",
      authorization: SECRET_ACCESS_KEY,
      raw_body: "media bytes must not appear",
      media_bytes: "media bytes must not appear",
    } as typeof base & Record<string, string>;
    const redacted = redactStagingEvidence(polluted);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("credential.invalid");
    expect(serialized).not.toContain(SECRET_ACCESS_KEY);
    expect(serialized).not.toContain("media bytes must not appear");
    const schema = (await Bun.file(
      new URL("../../docs/evidence/media-r2-sealing/staging-schema.json", import.meta.url),
    ).json()) as { required: string[] };
    expect(Object.keys(redacted).sort()).toEqual([...schema.required].sort());
    expect(() => redactStagingEvidence({ ...base, account_id: "https://secret.invalid" })).toThrow(
      "unsafe account_id",
    );
  });
});
