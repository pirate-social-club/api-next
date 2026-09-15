import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasCommunityCreationCredentials,
  makeCommunityCreationAcceptance,
  writeCommunityCreationEvidence,
} from "./staging-community-creation-acceptance.ts";

const credentials = {
  E2E_PRIVY_EMAIL: "e2e@example.test",
  E2E_PRIVY_OTP: "123456",
} as const;
const target = "https://web-next-staging.pirate.sc";

describe("community creation acceptance", () => {
  test("credentials accept both reviewed name pairs and refuse a malformed OTP", () => {
    expect(hasCommunityCreationCredentials(credentials)).toBeTrue();
    expect(
      hasCommunityCreationCredentials({
        MODERATION_E2E_OWNER_EMAIL: "owner@example.test",
        MODERATION_E2E_OWNER_OTP: "654321",
      }),
    ).toBeTrue();
    expect(
      hasCommunityCreationCredentials({ E2E_PRIVY_EMAIL: "e2e@example.test", E2E_PRIVY_OTP: "12" }),
    ).toBeFalse();
    expect(hasCommunityCreationCredentials({ E2E_PRIVY_EMAIL: "e2e@example.test" })).toBeFalse();
  });

  test("missing credentials, an unreviewed target or an unbounded timeout refuse before running", () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return { ok: true, stdout: "", stderr: "" };
    };
    expect(() =>
      makeCommunityCreationAcceptance({
        solidRoot: "/solid",
        baseUrl: target,
        timeoutMs: 600_000,
        env: { E2E_PRIVY_EMAIL: "e2e@example.test" },
        run,
      }),
    ).toThrow("staging_community_creation_credentials_missing");
    expect(() =>
      makeCommunityCreationAcceptance({
        solidRoot: "/solid",
        baseUrl: "http://web-next-staging.pirate.sc",
        timeoutMs: 600_000,
        env: credentials,
        run,
      }),
    ).toThrow("staging_community_creation_target_invalid");
    expect(() =>
      makeCommunityCreationAcceptance({
        solidRoot: "/solid",
        baseUrl: target,
        timeoutMs: 0,
        env: credentials,
        run,
      }),
    ).toThrow("staging_community_creation_timeout_invalid");
    expect(ran).toBeFalse();
  });

  test("runs the reviewed journey with mutation consent and records only its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "community-creation-acceptance-"));
    try {
      let observed:
        | {
            readonly cwd?: string;
            readonly env?: Readonly<Record<string, string | undefined>>;
            readonly timeoutMs?: number;
          }
        | undefined;
      const acceptance = makeCommunityCreationAcceptance({
        solidRoot: "/solid-checkout",
        baseUrl: target,
        timeoutMs: 600_000,
        env: credentials,
        now: () => "2026-09-14T00:00:00.000Z",
        run: async (input) => {
          observed = input;
          return { ok: true, stdout: "1 passed", stderr: "sanitized" };
        },
        recordEvidence: (evidence) => writeCommunityCreationEvidence(directory, evidence),
      });
      await acceptance();
      expect(observed?.cwd).toBe("/solid-checkout");
      expect(observed?.timeoutMs).toBe(600_000);
      expect(observed?.env?.E2E_ALLOW_MUTATION).toBe("1");
      expect(observed?.env?.E2E_BASE_URL).toBe(target);
      const path = join(directory, "staging-community-creation-acceptance.json");
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(record.result).toBe("passed");
      expect(record.target).toBe(target);
      expect(record.output_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.recorded_at).toBe("2026-09-14T00:00:00.000Z");
      expect(JSON.stringify(record)).not.toContain("123456");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a failed journey refuses the release and records no acceptance", async () => {
    let recorded = false;
    const acceptance = makeCommunityCreationAcceptance({
      solidRoot: "/solid-checkout",
      baseUrl: target,
      timeoutMs: 600_000,
      env: credentials,
      run: async () => ({ ok: false, stdout: "failure diagnostics", stderr: "trace" }),
      recordEvidence: async () => {
        recorded = true;
      },
    });
    await expect(acceptance()).rejects.toThrow("staging_community_creation_failed");
    expect(recorded).toBeFalse();
  });
});
