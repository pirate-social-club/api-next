import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type DanceNetworkNamespace,
  makeDanceNetworkAdmission,
} from "./dance-network-admission.ts";
import { DANCE_NETWORK_DAY_MS } from "./dance-network-admission-model.ts";

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
const now = 20_000 * DANCE_NETWORK_DAY_MS + 1_000;
function fixture(overrides: Partial<Parameters<typeof makeDanceNetworkAdmission>[0]> = {}) {
  const calls: Array<{ bucketName: string; commandDigest: string }> = [];
  const namespace: DanceNetworkNamespace = {
    getByName: (name) => ({
      admit: async (request) => {
        expect(request.bucketName).toBe(name);
        calls.push(request);
        return { allowed: true, retryAfterSeconds: 0 };
      },
    }),
  };
  return {
    calls,
    admit: makeDanceNetworkAdmission({
      accountId: "account",
      edgeClientIp: "192.0.2.1",
      hmacKeyBase64: key,
      namespace,
      now: () => now,
      ...overrides,
    }),
  };
}
describe("Dance network admission adapter", () => {
  test("stores only daily keyed address and command digests with stable retry identity", async () => {
    const f = fixture();
    await Effect.runPromise(f.admit("command"));
    await Effect.runPromise(f.admit("command"));
    await Effect.runPromise(f.admit("other-command"));
    expect(f.calls[0]).toEqual(f.calls[1]);
    expect(f.calls[0]?.bucketName).toBe(f.calls[2]?.bucketName);
    expect(f.calls[0]?.commandDigest).not.toBe(f.calls[2]?.commandDigest);
    expect(f.calls[0]?.bucketName).toMatch(/^dance-network-v1:20000:[a-f0-9]{64}$/u);
    expect(f.calls[0]?.commandDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(f.calls)).not.toMatch(/192\.0\.2\.1|account|other-command/u);
  });
  test("separates network days and accounts and canonicalizes equivalent IPv6 addresses", async () => {
    const a = fixture({ edgeClientIp: "2001:db8::1" });
    const b = fixture({ edgeClientIp: "2001:0db8:0000:0000:0000:0000:0000:0001" });
    const c = fixture({ edgeClientIp: "2001:db8::1", now: () => now + DANCE_NETWORK_DAY_MS });
    const d = fixture({ edgeClientIp: "2001:db8::1", accountId: "another-account" });
    for (const f of [a, b, c, d]) await Effect.runPromise(f.admit("command"));
    expect(a.calls).toEqual(b.calls);
    expect(a.calls[0]?.bucketName).not.toBe(c.calls[0]?.bucketName);
    expect(a.calls[0]?.bucketName).toBe(d.calls[0]?.bucketName);
    expect(a.calls[0]?.commandDigest).not.toBe(d.calls[0]?.commandDigest);
  });
  test("missing and invalid authority fails closed without an RPC", async () => {
    for (const overrides of [
      { edgeClientIp: undefined },
      { edgeClientIp: "192.0.2.1, 192.0.2.2" },
      { edgeClientIp: "2001:db8::1%eth0" },
      { hmacKeyBase64: undefined },
      { hmacKeyBase64: btoa("short") },
      { namespace: undefined },
      { accountId: "" },
    ]) {
      const f = fixture(overrides);
      await expect(Effect.runPromise(f.admit("command"))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(f.calls).toHaveLength(0);
    }
  });
  test("exhaustion preserves the exact retry interval", async () => {
    const f = fixture({
      namespace: {
        getByName: () => ({ admit: async () => ({ allowed: false, retryAfterSeconds: 123 }) }),
      },
    });
    await expect(Effect.runPromise(f.admit("command"))).rejects.toMatchObject({
      _tag: "RateLimited",
      retry_after_seconds: 123,
    });
  });
  test("malformed decisions and RPC failures cannot admit a capture", async () => {
    for (const response of [
      { allowed: true, retryAfterSeconds: 1 },
      { allowed: false, retryAfterSeconds: 0 },
      { allowed: true, retryAfterSeconds: 0, extra: true },
    ]) {
      const namespace = {
        getByName: () => ({ admit: async () => response }),
      } as DanceNetworkNamespace;
      await expect(
        Effect.runPromise(fixture({ namespace }).admit("command")),
      ).rejects.toMatchObject({ reason: "unavailable" });
    }
    const namespace: DanceNetworkNamespace = {
      getByName: () => ({
        admit: async () => {
          throw new Error("offline");
        },
      }),
    };
    await expect(Effect.runPromise(fixture({ namespace }).admit("command"))).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
  test("an RPC that never returns releases the caller within the two-second budget", async () => {
    const namespace: DanceNetworkNamespace = {
      getByName: () => ({ admit: () => new Promise(() => {}) }),
    };
    const started = performance.now();
    await expect(Effect.runPromise(fixture({ namespace }).admit("command"))).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(performance.now() - started).toBeLessThan(3_500);
  });
});
