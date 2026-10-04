import { expect, test } from "bun:test";
import { fixtureTable, planFixtureSeed } from "./seed-fixtures.ts";

test("fixture seeding excludes historical rewards, qualifications, attempts and sessions", () => {
  for (const table of [
    "reward_chain_effects",
    "reward_ledger_credits",
    "song_reward_offers",
    "study_sessions_v2",
    "study_attempts_v2",
    "study_review_items",
    "karaoke_attempts",
    "proof_sessions",
    "app_sessions",
    "users; DROP TABLE users",
  ]) {
    expect(() => fixtureTable(table)).toThrow("requires review");
  }
});

test("fixture source cannot connect to a different database", async () => {
  await expect(
    planFixtureSeed("postgres://shared:fixture@us-east-3.pg.psdb.cloud/postgres"),
  ).rejects.toThrow("identity mismatch");
});
