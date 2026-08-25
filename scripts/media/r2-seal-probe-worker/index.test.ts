import { describe, expect, test } from "bun:test";

import worker from "./index";

const TOKEN = "proof-token-with-at-least-twenty-bytes";
const ACKNOWLEDGEMENT = "ACKNOWLEDGE_DISPOSABLE_R2_BINDING_PROOF_V1";

Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value: (left: ArrayBuffer, right: ArrayBuffer): boolean => {
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    if (leftBytes.byteLength !== rightBytes.byteLength) return false;
    let difference = 0;
    for (let index = 0; index < leftBytes.byteLength; index += 1) {
      difference |= (leftBytes.at(index) ?? 0) ^ (rightBytes.at(index) ?? 0);
    }
    return difference === 0;
  },
});

function request(body: unknown, token = TOKEN): Request {
  return new Request("https://proof.invalid/audit", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function env(list: R2Bucket["list"]): Env {
  return {
    PROOF_BUCKET: { list } as R2Bucket,
    PROOF_PREFIX: "song-e2e",
    PROOF_RUN_TOKEN: TOKEN,
    PROOF_TARGET_LABEL: "disposable-proof",
  } as unknown as Env;
}

describe("Workers-binding R2 proof audit", () => {
  test("paginates the proof prefix and returns only aggregate residual evidence", async () => {
    const calls: R2ListOptions[] = [];
    const list = (async (options: R2ListOptions) => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          objects: [{ key: "song-e2e/private-run/ingress", size: 7 }],
          truncated: true,
          cursor: "next-page",
          delimitedPrefixes: [],
        } as unknown as R2Objects;
      }
      return {
        objects: [{ key: "song-e2e/private-run/sealed", size: 11 }],
        truncated: false,
        delimitedPrefixes: [],
      } as unknown as R2Objects;
    }) as R2Bucket["list"];

    const response = await worker.fetch(
      request({ acknowledgement: ACKNOWLEDGEMENT }) as Parameters<typeof worker.fetch>[0],
      env(list),
    );
    const evidence = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { prefix: "song-e2e/", limit: 1_000 },
      { prefix: "song-e2e/", limit: 1_000, cursor: "next-page" },
    ]);
    expect(evidence).toEqual({
      version: "r2-binding-proof-v1",
      outcome: "audit_complete",
      scope: "configured_proof_prefix",
      object_count: 2,
      total_bytes: 18,
      pages: 2,
      complete: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-run");
  });

  test("fails closed when a truncated listing omits its cursor", async () => {
    const list = (async () =>
      ({
        objects: [],
        truncated: true,
        delimitedPrefixes: [],
      }) as unknown as R2Objects) as R2Bucket["list"];

    const response = await worker.fetch(
      request({ acknowledgement: ACKNOWLEDGEMENT }) as Parameters<typeof worker.fetch>[0],
      env(list),
    );
    const evidence = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(evidence).toEqual({
      version: "r2-binding-proof-v1",
      outcome: "closed_audit_cursor_missing",
      complete: false,
    });
  });
});
