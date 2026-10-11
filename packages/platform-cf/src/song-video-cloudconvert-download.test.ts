import { describe, expect, test } from "bun:test";
import { downloadSongVideoCloudConvertMaster } from "./song-video-cloudconvert-download.ts";

const exportUrl = "https://storage.cloudconvert.com/job-1/master.mp4?token=secret";

describe("CloudConvert master download", () => {
  test("reads a bounded master without forwarding the API credential", async () => {
    const content = new Uint8Array([1, 2, 3]);
    const result = await downloadSongVideoCloudConvertMaster({
      exportUrl,
      fetch: async (url, init) => {
        expect(url).toBe(exportUrl);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(init.headers).toBeUndefined();
        return new Response(content, { headers: { "content-length": "3" } });
      },
    });
    expect(result.bytes).toEqual(content);
    expect(result.sha256).toBe(
      Buffer.from(await crypto.subtle.digest("SHA-256", content)).toString("hex"),
    );
  });

  test("accepts the exact regional storage host observed on staging", async () => {
    const result = await downloadSongVideoCloudConvertMaster({
      exportUrl: "https://us-east.storage.cloudconvert.com/job-1/master.mp4?token=fixture",
      fetch: async (_url, init) => {
        expect(init.headers).toBeUndefined();
        expect(init.redirect).toBe("manual");
        return new Response(new Uint8Array([1]), { headers: { "content-length": "1" } });
      },
    });
    expect(result.bytes).toEqual(new Uint8Array([1]));
  });

  test("refuses regional lookalikes, extra subdomains, credentials and ports", async () => {
    for (const exportUrl of [
      "https://us-east.storage.cloudconvert.com.attacker.example/master.mp4",
      "https://attacker.us-east.storage.cloudconvert.com/master.mp4",
      "https://us-east.storage.cloudconvert.com:444/master.mp4",
      "https://user:password@us-east.storage.cloudconvert.com/master.mp4",
      "http://us-east.storage.cloudconvert.com/master.mp4",
    ]) {
      await expect(
        downloadSongVideoCloudConvertMaster({
          exportUrl,
          fetch: async () => {
            throw new Error("must not fetch");
          },
        }),
      ).rejects.toThrow("invalid CloudConvert export URL");
    }
  });

  test("refuses a foreign host before fetch", async () => {
    let calls = 0;
    await expect(
      downloadSongVideoCloudConvertMaster({
        exportUrl: "https://attacker.example/master.mp4",
        fetch: async () => {
          calls++;
          return new Response("bad");
        },
      }),
    ).rejects.toThrow("invalid CloudConvert export URL");
    expect(calls).toBe(0);
  });

  test("refuses redirects and wrong lengths without exposing signed URLs", async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }),
      new Response(new Uint8Array([1, 2]), { headers: { "content-length": "3" } }),
      new Response(new Uint8Array([1]), { headers: { "content-length": "25165825" } }),
    ]) {
      await expect(
        downloadSongVideoCloudConvertMaster({
          exportUrl,
          fetch: async () => response,
        }),
      ).rejects.toThrow("CloudConvert export unavailable or invalid");
    }
  });
});

test("reports a fetch class without signed URLs, exception messages or arbitrary names", async () => {
  for (const error of [
    new TypeError(`receiver failed ${exportUrl}`),
    Object.assign(new Error(exportUrl), { name: exportUrl }),
  ]) {
    const result = await downloadSongVideoCloudConvertMaster({
      exportUrl,
      fetch: async () => {
        throw error;
      },
    }).catch((error) => error as Error);
    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain("phase=fetch");
    expect(message).toContain(error instanceof TypeError ? "error=TypeError" : "error=Error");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("https:");
    expect(message).not.toContain("receiver failed");
  }
});

test("distinguishes response, declared length, body read and length failures safely", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError(exportUrl));
    },
  });
  for (const [response, phase] of [
    [new Response(null, { status: 503 }), "response"],
    [
      new Response(new Uint8Array([1]), { headers: { "content-length": exportUrl } }),
      "declared-length",
    ],
    [new Response(broken), "body-read"],
    [
      new Response(new Uint8Array([1, 2]), { headers: { "content-length": "3" } }),
      "length-mismatch",
    ],
    [
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "2" } }),
      "length-mismatch",
    ],
  ] as const) {
    const result = await downloadSongVideoCloudConvertMaster({
      exportUrl,
      fetch: async () => response,
    }).catch((error) => error as Error);
    expect((result as Error).message).toContain(`phase=${phase}`);
    expect((result as Error).message).not.toContain("secret");
    expect((result as Error).message).not.toContain("https:");
  }
});

test("reports admission and expired deadlines without making a request", async () => {
  let requests = 0;
  for (const input of [
    { exportUrl: "https://foreign.example/secret", phase: "url" },
    { exportUrl, deadlineMs: 1, now: () => 2, phase: "deadline" },
  ]) {
    const result = await downloadSongVideoCloudConvertMaster({
      ...input,
      fetch: async () => {
        requests++;
        return new Response("unused");
      },
    }).catch((error) => error as Error);
    expect((result as Error).message).toContain(`phase=${input.phase} error=Error`);
    expect((result as Error).message).not.toContain("secret");
  }
  expect(requests).toBe(0);
});
