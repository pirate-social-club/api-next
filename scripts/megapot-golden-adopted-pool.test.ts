import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { assertGoldenAdoptedPool } from "./megapot-golden-adopted-pool.ts";
import { withGoldenJournal } from "./megapot-golden-journal.ts";
import { rehearsalInput } from "./megapot-golden-multi.fixture.ts";
import { parseMultiGoldenInput } from "./megapot-golden-multi-input.ts";
import { prepareGoldenPool } from "./megapot-golden-multi-pool.ts";

const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const sender = `0x${"a".repeat(40)}`;
const transactionHash = `0x${"b".repeat(64)}`;
const handoff = {
  offer_id: "offer",
  leg_id: "leg",
  funding_effect_id: "funding",
  transaction_hash: transactionHash,
  sender_address: sender,
};
const input = () => parseMultiGoldenInput({ ...rehearsalInput(), app_funded_pool: handoff });

function databaseRow() {
  return {
    community_id: "community",
    post_id: "song",
    audio_revision: 1,
    created_by_account_id: "sponsor-account",
    offer_status: "active",
    starts_at: new Date("2026-09-21T09:59:00.000Z"),
    ends_at: new Date("2026-09-21T11:00:00.000Z"),
    kind: "megapot_pool",
    leg_status: "active",
    funder_account_id: "sponsor-account",
    chain_id: 84532,
    token_address: token,
    token_decimals: 6,
    funded_atomic: "1000",
    max_ticket_price_atomic: "100",
    entry_cutoff_seconds: 300,
    eligible_activities: ["study", "karaoke"],
    min_score_bps: 7000,
    empty_pool_policy: "no_purchase",
    funding_status: "confirmed",
    sender_address: sender,
    recipient_address: `0x${"c".repeat(40)}`,
    expected_amount_atomic: "1000",
    confirmed_amount_atomic: "1000",
    transaction_hash: transactionHash,
    attestation_environment: "staging",
    attestation_status: "active",
    custody_address: `0x${"c".repeat(40)}`,
    sponsor_account_id: "sponsor-account",
    sponsor_wallet_address: sender,
    pool_leg_count: 1,
    funding_effect_count: 1,
  };
}

function clientWithRows(rows: unknown[]): Pick<Client, "query"> {
  return { query: async () => ({ rows }) } as unknown as Pick<Client, "query">;
}

function funding() {
  return {
    object: "megapot_pool_funding",
    action: "fund_with_usdc",
    funding_effect_id: "funding",
    leg_id: "leg",
    status: "confirmed",
    chain_id: 84532,
    token_address: token,
    token_decimals: 6,
    sender_address: sender,
    recipient_address: `0x${"c".repeat(40)}`,
    expected_amount_atomic: "1000",
    confirmed_amount_atomic: "1000",
    required_confirmations: 1,
    transaction_hash: transactionHash,
  };
}

function pool() {
  return {
    object: "song_megapot_pool_projection",
    offer_id: "offer",
    leg_id: "leg",
    community_id: "community",
    post_id: "song",
    offer_status: "active",
    leg_status: "active",
    chain_id: 84532,
    token_address: token,
    token_decimals: 6,
    funded_atomic: "1000",
    available_budget_atomic: "1000",
    max_ticket_price_atomic: "100",
    entry_cutoff_seconds: 300,
    eligible_activities: ["study", "karaoke"],
    min_score_bps: 7000,
    empty_pool_policy: "no_purchase",
    qualification_policies: null,
    allocation_rule: "equal_v1",
    ticket_custody: "pirate",
    winnings_basis: "net_of_referral_win_share",
    fallback_disclosure: null,
    drawing: {
      object: "megapot_pool_drawing_projection",
      drawing_id: "101",
      lifecycle_status: "entry_open",
      state: "entry_open",
      entry_cutoff_at: "2026-09-21T10:20:00.000Z",
      beneficiary_count: 0,
      ticket_price_ceiling_atomic: "100",
      actual_ticket_cost_atomic: "0",
      gross_prize_pool_atomic: null,
      global_tickets_bought: null,
      prize_pool_observed_at: null,
      prize_pool_basis:
        "gross_observed_before_referral_win_share_terminal_last_observed_pre_rollover",
      global_tickets_basis: "drawing_wide_all_megapot_buyers",
      net_winnings_atomic: "0",
      commitment_reference: null,
      snapshot_hash: null,
      ticket_id: null,
      purchase_transaction_hash: null,
      claim_transaction_hash: null,
    },
  };
}

test("adopted plan cannot also create or observe runner funding", () => {
  expect(() =>
    parseMultiGoldenInput({ ...input(), funding_transaction_hash: transactionHash }),
  ).toThrow("Invalid mixed-participant rehearsal plan");
});

test("read-only handoff rejects changed terms, wallet, effect count and sponsor", async () => {
  const plan = input();
  await expect(
    assertGoldenAdoptedPool(clientWithRows([databaseRow()]), plan, token),
  ).resolves.toBeUndefined();
  for (const change of [
    { starts_at: new Date("2026-09-21T09:58:00.000Z") },
    { sponsor_wallet_address: `0x${"d".repeat(40)}` },
    { funding_effect_count: 2 },
    { funder_account_id: "other-account" },
    { eligible_activities: ["study"] },
    { transaction_hash: `0x${"d".repeat(64)}` },
    { recipient_address: `0x${"d".repeat(40)}` },
    { attestation_status: "retired" },
  ]) {
    await expect(
      assertGoldenAdoptedPool(clientWithRows([{ ...databaseRow(), ...change }]), plan, token),
    ).rejects.toThrow("exact approved handoff");
  }
  await expect(assertGoldenAdoptedPool(clientWithRows([]), plan, token)).rejects.toThrow("missing");
});

test("app-funded handoff uses GET only and binds the same journal on replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "golden-adopted-"));
  const path = join(directory, "journal.jsonl");
  const plan = input();
  const methods: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    methods.push(init?.method ?? "missing");
    return Response.json(url.includes("/funding/") ? { funding: funding() } : { pool: pool() });
  };
  const options = {
    apiOrigin: "https://api-next-staging.pirate.sc",
    authorization: "Bearer sponsor",
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await withGoldenJournal(path, plan, async (journal) => {
        expect(await prepareGoldenPool(plan, options, journal, { fetcher })).toMatchObject({
          state: "funded",
          leg_id: "leg",
          drawing_id: "101",
        });
      });
    }
    expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
    await expect(
      withGoldenJournal(
        path,
        { ...plan, app_funded_pool: { ...handoff, offer_id: "other" } },
        async () => null,
      ),
    ).rejects.toThrow("Journal plan mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mismatched app receipt and drawing never persist a handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "golden-adopted-mismatch-"));
  const plan = input();
  try {
    for (const [index, response] of [
      { funding: { ...funding(), transaction_hash: `0x${"d".repeat(64)}` } },
      { pool: { ...pool(), available_budget_atomic: "900" } },
      { pool: { ...pool(), drawing: { ...pool().drawing, lifecycle_status: "committed" } } },
    ].entries()) {
      const methods: string[] = [];
      await withGoldenJournal(join(directory, `journal-${index}.jsonl`), plan, async (journal) => {
        const fetcher = async (url: string, init?: RequestInit) => {
          methods.push(init?.method ?? "missing");
          return Response.json(
            url.includes("/funding/")
              ? "funding" in response
                ? response
                : { funding: funding() }
              : "pool" in response
                ? response
                : { pool: pool() },
          );
        };
        await expect(
          prepareGoldenPool(
            plan,
            { apiOrigin: "https://api-next-staging.pirate.sc", authorization: "Bearer sponsor" },
            journal,
            { fetcher },
          ),
        ).rejects.toThrow("exact open approved drawing");
        expect(journal.state.leg_id).toBeNull();
        expect(journal.state.funding_effect_id).toBeNull();
        expect(journal.state.drawing_id).toBeNull();
      });
      expect(methods.every((method) => method === "GET")).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
