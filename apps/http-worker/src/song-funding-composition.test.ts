import { expect, mock, test } from "bun:test";
import { makeSessionCryptoFromEnv } from "../../../packages/platform-cf/src/session-crypto.ts";
import { moderatedDanceContextFixture } from "../../../packages/testing/src/moderated-dance-context-fixture.ts";
import { readySongFundingContextFixture } from "../../../packages/testing/src/song-funding-context-fixture.ts";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { createProductionHttpWorker } = await import("./composition.ts");

test("serving HTTP composition isolates Funding reads from Dance and propagates the selected Safe/EOA lane", async () => {
  const base = await makeHttpWorkerTestBindings();
  const danceFixture = await moderatedDanceContextFixture(true);
  const account = danceFixture.actor.accountId;
  const sessionId = `bs_${"1".repeat(32)}`;
  const crypto = await makeSessionCryptoFromEnv(base);
  const token = await crypto.sign({
    sub: account,
    scope: String(base.PIRATE_APP_JWT_SCOPE),
    browserSessionId: sessionId,
  });
  const context = await readySongFundingContextFixture(account);
  for (const lane of ["safe", "eoa", "off"] as const) {
    const calls: { url: string; text: string }[] = [];
    const worker = await createProductionHttpWorker(
      {
        ...base,
        API_NEXT_ENV: "staging",
        CONTROL_PLANE: { connectionString: "postgres://dance@fixture.invalid/db" },
        SONG_FUNDING_COMMANDS: { connectionString: "postgres://funding@fixture.invalid/db" },
        MEGAPOT_REWARDS_ENABLED: lane === "eoa" ? "true" : "false",
        SAFE_POOL_PILOT_ENABLED: lane === "safe" ? "true" : "false",
        SAFE_POOL_ATTESTATION_ID: "fixture-safe",
        SAFE_POOL_RPC_URL: "https://rpc.invalid/",
      },
      {
        database_client_factory: (url) => ({
          connect: async () => {},
          end: async () => {},
          query: async ({ text }) => {
            calls.push({ url, text });
            const rows = text.includes("WITH RECURSIVE identity_chain")
              ? [
                  {
                    current_user_id: account,
                    alias_path: [],
                    depth: 0,
                    cycle: false,
                    alias_count: 0,
                    terminal_active: true,
                  },
                ]
              : text.includes("read_browser_session_access_v1")
                ? [
                    {
                      packet: {
                        sessionId,
                        accountId: account,
                        credentialUserId: account,
                        scope: String(base.PIRATE_APP_JWT_SCOPE),
                        origin: "https://app.example.test",
                        renewable: true,
                        idleExpiresAt: Math.floor(Date.now() / 1000) + 3600,
                        absoluteExpiresAt: Math.floor(Date.now() / 1000) + 7200,
                        now: Math.floor(Date.now() / 1000),
                      },
                    },
                  ]
                : text.includes("read_song_contribution_context_v2")
                  ? [{ packet: context }]
                  : text.includes("read_shared_song_megapot_participation_v2")
                    ? [{ packet: null }]
                    : text.includes("read_owned_moderated_dance_capture_context_v1")
                      ? [{ packet: danceFixture.packet }]
                      : [];
            return { rows, rowCount: rows.length };
          },
        }),
      },
    );
    const headers = { cookie: `__Host-pirate_session=${token}` };
    const response = await worker.request(
      "https://worker.test/communities/community/posts/song/megapot-funding-context?persona_id=persona",
      { headers },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(
      lane === "off" ? { readiness: "unavailable", reason: "paused" } : { readiness: "ready" },
    );
    const dance = await worker.request(
      `https://worker.test/communities/${danceFixture.actor.communityId}/dance/moderated-sessions/${danceFixture.actor.sessionId}/capture-context`,
      { headers },
    );
    expect(dance.status).toBe(200);
    expect(await dance.json()).toMatchObject({
      rewards_enabled: lane !== "off",
      reward_mode: "reward_eligible",
    });
    const participation = await worker.request(
      "https://worker.test/communities/community/posts/song/megapot-participation",
      { headers },
    );
    expect(participation.status).toBe(lane === "off" ? 502 : 200);
    expect(
      calls
        .filter((c) => c.text.includes("read_shared_song_megapot_participation_v2"))
        .map((c) => c.url),
    ).toEqual(lane === "off" ? [] : ["postgres://dance@fixture.invalid/db"]);
    const fundingCalls = calls.filter((c) => c.text.includes("read_song_contribution_context_v2"));
    expect(fundingCalls.map((c) => c.url)).toEqual(["postgres://funding@fixture.invalid/db"]);
    expect(
      calls
        .filter((c) => c.text.includes("read_owned_moderated_dance_capture_context_v1"))
        .map((c) => c.url),
    ).toEqual(["postgres://dance@fixture.invalid/db"]);
  }
});

test("enabled serving composition refuses missing or aliased Funding bindings before serving", async () => {
  const base = await makeHttpWorkerTestBindings();
  for (const binding of [undefined, base.CONTROL_PLANE])
    await expect(
      createProductionHttpWorker({
        ...base,
        API_NEXT_ENV: "staging",
        SAFE_POOL_PILOT_ENABLED: "true",
        SAFE_POOL_ATTESTATION_ID: "fixture-safe",
        SAFE_POOL_RPC_URL: "https://rpc.invalid/",
        SONG_FUNDING_COMMANDS: binding,
      }),
    ).rejects.toThrow("Dedicated song funding connection");
});
