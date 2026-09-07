import { expect, test } from "bun:test";
import {
  makeStagingKaraokeR2Observer,
  parseKaraokeMultipartPage,
  STAGING_KARAOKE_BUCKET,
} from "./staging-karaoke-r2-observer.ts";

const key = "karaoke/account/attempt.pcm";
const xml = (body = "", truncated = false) =>
  `<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${STAGING_KARAOKE_BUCKET}</Bucket><Prefix>${key}</Prefix><IsTruncated>${truncated}</IsTruncated>${body}</ListMultipartUploadsResult>`;
const receipt = { "x-amz-request-id": "fixture-request" };
const options = {
  accountId: "a".repeat(32),
  credentials: { accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" },
};
const authority = { accountId: "account", attemptId: "attempt" };

test("verified exact-key absence requires bucket checks and exhaustive multipart pagination", async () => {
  const calls: { method: string; url: URL }[] = [];
  const observer = makeStagingKaraokeR2Observer({
    ...options,
    fetch: (async (raw, init) => {
      const url = new URL(String(raw));
      const method = String(init?.method);
      calls.push({ method, url });
      expect(url.hostname).toBe(`${options.accountId}.r2.cloudflarestorage.com`);
      expect(init?.redirect).toBe("manual");
      if (method === "GET") {
        const body = url.searchParams.has("key-marker")
          ? xml()
          : xml(
              `<NextKeyMarker>${key}</NextKeyMarker><NextUploadIdMarker>upload-1</NextUploadIdMarker>`,
              true,
            );
        return new Response(body, { headers: receipt });
      }
      return new Response(null, {
        status: url.pathname.endsWith(".pcm") ? 404 : 200,
        headers: receipt,
      });
    }) as typeof fetch,
  });
  const result = await observer.observe(authority);
  expect(result.head.state).toBe("absent");
  expect(result.uploads.pages.length).toBe(2);
  expect(calls.filter((value) => value.method === "HEAD").length).toBe(3);
  expect(calls.every((value) => ["GET", "HEAD"].includes(value.method))).toBe(true);
});

test("rejects malformed, duplicated scalar, DTD, wrong prefix and missing continuation", () => {
  for (const value of [
    xml().replace("</Prefix>", "</Wrong>"),
    xml("<Prefix>wrong</Prefix>"),
    `<!DOCTYPE a [<!ENTITY b 'expanded'>]>${xml()}`,
    xml().replace(key, "different"),
    xml("", true),
  ])
    expect(() => parseKaraokeMultipartPage(value, key)).toThrow();
});

test("retains adjacent prefix keys for evidence instead of authorizing their deletion", () => {
  const result = parseKaraokeMultipartPage(
    xml(`<Upload><Key>${key}.other</Key><UploadId>other-upload</UploadId></Upload>`),
    key,
  );
  expect(result.uploads).toEqual([{ key: `${key}.other`, uploadId: "other-upload" }]);
});

test("bucket denial or disappearing bucket never becomes object absence", async () => {
  for (const at of [1, 4]) {
    let calls = 0;
    const observer = makeStagingKaraokeR2Observer({
      ...options,
      fetch: (async (_raw, init) => {
        calls++;
        if (calls === at) return new Response(null, { status: 404, headers: receipt });
        if (init?.method === "GET") return new Response(xml(), { headers: receipt });
        return new Response(null, { status: calls === 3 ? 404 : 200, headers: receipt });
      }) as typeof fetch,
    });
    await expect(observer.observe(authority)).rejects.toThrow("observation_failed");
  }
});

test("rejects repeated pagination and unsafe authority before any mutation", async () => {
  let calls = 0;
  const observer = makeStagingKaraokeR2Observer({
    ...options,
    fetch: (async (_raw, init) => {
      calls++;
      return init?.method === "GET"
        ? new Response(
            xml(
              `<NextKeyMarker>${key}</NextKeyMarker><NextUploadIdMarker>same</NextUploadIdMarker>`,
              true,
            ),
            { headers: receipt },
          )
        : new Response(null, { headers: receipt });
    }) as typeof fetch,
  });
  await expect(observer.observe({ accountId: "../other", attemptId: "attempt" })).rejects.toThrow(
    "authority_denied",
  );
  expect(calls).toBe(0);
  await expect(observer.observe(authority)).rejects.toThrow("observation_failed");
  expect(calls).toBe(3);
});
