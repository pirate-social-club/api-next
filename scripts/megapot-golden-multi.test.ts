import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMultiGolden } from "./megapot-base-sepolia-golden-multi.ts";
import { endpoint } from "./megapot-golden-http.ts";
import { withGoldenJournal } from "./megapot-golden-journal.ts";
import {
  onePalmRehearsalInput,
  rehearsalInput,
  rehearsalObservation,
  rehearsalTime,
} from "./megapot-golden-multi.fixture.ts";
import {
  assertMultiParticipantPreflight,
  type MultiParticipantPreflight,
  parseMultiGoldenInput,
} from "./megapot-golden-multi-input.ts";
import {
  assertGoldenAdmission,
  evaluateGoldenSettlement,
  waitForGoldenSettlement,
} from "./megapot-golden-reconciliation.ts";

describe("multi-participant golden boundaries", () => {
  test("one verified account can do both activities beside an unverified negative", async () => {
    const input = onePalmRehearsalInput();
    expect(input.participants).toHaveLength(2);
    expect(
      await runMultiGolden(
        { ...input, authorization: null },
        { execute: false, reconcileOnly: false, environment: {} },
      ),
    ).toMatchObject({ mode: "dry-run", expected_shares: 1, live_calls: 0 });

    const observation = rehearsalObservation(input);
    expect(observation.qualifications).toHaveLength(3);
    expect(observation.shares).toHaveLength(1);
    expect(() => assertGoldenAdmission(input, observation)).not.toThrow();
    expect(evaluateGoldenSettlement(input, observation, rehearsalTime).state).toBe(
      "reconciled_no_win",
    );

    const beneficiary = observation.beneficiaries[0];
    if (!beneficiary) throw new Error("fixture");
    expect(
      evaluateGoldenSettlement(
        input,
        {
          ...observation,
          drawing_status: "credited",
          net_winnings_atomic: "101",
          claim_receipt_atomic: "101",
          credits: [
            {
              ...beneficiary,
              amount_atomic: "101",
              paid_atomic: "101",
              reserved_atomic: "0",
              state: "sent",
              receipt_confirmed: true,
            },
          ],
        },
        rehearsalTime,
      ).state,
    ).toBe("reconciled_win");
  });
  test("dry run needs no credentials, files, provider, or authorization", async () => {
    const input = { ...rehearsalInput(), authorization: null };
    expect(
      await runMultiGolden(input, { execute: false, reconcileOnly: false, environment: {} }),
    ).toMatchObject({ mode: "dry-run", expected_shares: 2, live_calls: 0 });
    await expect(
      runMultiGolden(input, { execute: true, reconcileOnly: false, environment: {} }),
    ).rejects.toThrow("authorization");
  });
  test("rejects duplicate accounts, missing negative, missing vocal provenance, and invalid caps", () => {
    const input = rehearsalInput();
    const first = input.participants[0];
    if (!first || !input.authorization) throw new Error("fixture");
    expect(() =>
      parseMultiGoldenInput({ ...input, participants: [first, first, input.participants[2]] }),
    ).toThrow();
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        participants: input.participants.map((p) => ({ ...p, expected_admission: "eligible" })),
      }),
    ).toThrow();
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        participants: input.participants.map((p) => ({ ...p, karaoke_audio: undefined })),
      }),
    ).toThrow();
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        authorization: { ...input.authorization, max_tickets: 2 },
      }),
    ).toThrow();
  });
  test("one-palm mode still requires both activities and a distinct negative", () => {
    const input = onePalmRehearsalInput();
    const verified = input.participants[0];
    const unverified = input.participants[1];
    if (!verified || !unverified) throw new Error("fixture");
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        participants: [{ ...verified, activities: ["study"] }, unverified],
      }),
    ).toThrow();
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        participants: [{ ...verified, activities: ["karaoke"] }, unverified],
      }),
    ).toThrow();
    expect(() => parseMultiGoldenInput({ ...input, participants: [verified] })).toThrow();
    expect(() =>
      parseMultiGoldenInput({
        ...input,
        participants: [{ ...verified, expected_admission: "verification_missing" }, unverified],
      }),
    ).toThrow();
  });
  test("unverified artifact must have no Very witness and current matching revisions", () => {
    const input = rehearsalInput();
    const participant = input.participants[2];
    if (!participant) throw new Error("fixture");
    const artifact: MultiParticipantPreflight = {
      object: "megapot_participant_preflight_v2",
      checked_at: new Date(rehearsalTime).toISOString(),
      valid_until: new Date(rehearsalTime + 600000).toISOString(),
      account_id: participant.account_id,
      persona_id: participant.persona_id,
      community_id: input.community_id,
      post_id: input.post_id,
      audio_revision: 1,
      lyrics_revision: 1,
      wallet_assignment_id: "wallet",
      wallet_address: `0x${"a".repeat(40)}`,
      verification_state: "verification_missing",
      very_evidence: [],
      study_exercise_count: 4,
      karaoke_revision_id: null,
      karaoke_line_count: 0,
      playback_kind: null,
    };
    expect(() =>
      assertMultiParticipantPreflight(artifact, input, participant, rehearsalTime),
    ).not.toThrow();
    expect(() =>
      assertMultiParticipantPreflight(
        { ...artifact, audio_revision: 2 },
        input,
        participant,
        rehearsalTime,
      ),
    ).toThrow();
    expect(() =>
      assertMultiParticipantPreflight(artifact, input, participant, rehearsalTime + 600000),
    ).toThrow();
    expect(() =>
      assertMultiParticipantPreflight(
        { ...artifact, verification_state: "eligible" },
        input,
        participant,
        rehearsalTime,
      ),
    ).toThrow();
  });
  test("rejects credential-bearing or redirected origins", () => {
    for (const origin of [
      "https://secret@api-next-staging.pirate.sc",
      "https://api-next-staging.pirate.sc:8443",
      "https://elsewhere.invalid",
    ])
      expect(() => endpoint(origin, "/")).toThrow();
    expect(() => endpoint("https://api-next-staging.pirate.sc", "//elsewhere.invalid")).toThrow();
  });
  test("journal binds plan but allows later exact funding hash, stores ambiguous activity durably", async () => {
    const directory = await mkdtemp(join(tmpdir(), "golden-journal-"));
    const path = join(directory, "run.jsonl");
    const input = rehearsalInput();
    try {
      await withGoldenJournal(path, input, async (journal) => {
        await journal.save({ ...journal.state, pending_activity: "karaoke:karaoke" });
        await expect(withGoldenJournal(path, input, async () => null)).rejects.toThrow();
      });
      await withGoldenJournal(
        path,
        { ...input, funding_transaction_hash: `0x${"a".repeat(64)}` },
        async (journal) => expect(journal.state.pending_activity).toBe("karaoke:karaoke"),
      );
      await expect(
        withGoldenJournal(path, { ...input, run_id: "changed" }, async () => null),
      ).rejects.toThrow("mismatch");
      expect(await readFile(path, "utf8")).not.toContain("AUTHORIZATION");
      await expect(
        withGoldenJournal(
          path,
          { ...input, funding_transaction_hash: `0x${"b".repeat(64)}` },
          async () => null,
        ),
      ).rejects.toThrow("funding transaction mismatch");
      await appendFile(path, '{"input_digest":');
      await expect(withGoldenJournal(path, input, async () => null)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("golden settlement acceptance", () => {
  test("losing drawing needs refund and no unresolved effects", () => {
    const input = rehearsalInput();
    const observation = rehearsalObservation();
    expect(evaluateGoldenSettlement(input, observation, rehearsalTime).state).toBe(
      "reconciled_no_win",
    );
    for (const change of [
      { unresolved_effect_count: 1 },
      { other_unresolved_drawings: 1 },
      { refunded_atomic: "0" },
      { refund_receipt_atomic: "0" },
      { reserved_atomic: "1" },
    ]) {
      expect(
        evaluateGoldenSettlement(input, { ...observation, ...change }, rehearsalTime).terminal,
      ).toBe(false);
    }
    expect(() =>
      evaluateGoldenSettlement(input, { ...observation, ticket_count: 2 }, rehearsalTime),
    ).toThrow("bounds");
  });
  test("a natural win requires confirmed payout for every frozen beneficiary", () => {
    const input = rehearsalInput();
    const base = rehearsalObservation();
    const observation = {
      ...base,
      drawing_status: "credited",
      net_winnings_atomic: "601",
      claim_receipt_atomic: "601",
      credits: base.beneficiaries.map((b) => ({
        ...b,
        amount_atomic: b.ordinal === 0 ? "301" : "300",
        paid_atomic: b.ordinal === 0 ? "301" : "300",
        reserved_atomic: "0",
        state: "sent",
        receipt_confirmed: true,
      })),
    };
    expect(evaluateGoldenSettlement(input, observation, rehearsalTime).state).toBe(
      "reconciled_win",
    );
    expect(() =>
      evaluateGoldenSettlement(
        input,
        {
          ...observation,
          beneficiaries: observation.beneficiaries.map((b) => ({ ...b, ordinal: 0 })),
        },
        rehearsalTime,
      ),
    ).toThrow("beneficiaries");
    expect(
      evaluateGoldenSettlement(
        input,
        {
          ...observation,
          credits: observation.credits.map((c) => ({ ...c, receipt_confirmed: false })),
        },
        rehearsalTime,
      ).terminal,
    ).toBe(false);
    expect(() =>
      evaluateGoldenSettlement(
        input,
        {
          ...observation,
          credits: observation.credits.map((c) => ({ ...c, amount_atomic: "300" })),
        },
        rehearsalTime,
      ),
    ).toThrow("split");
  });
  test("dual completion requires two qualifications but one share and one admission decision", () => {
    const base = rehearsalInput();
    const first = base.participants[0];
    const karaoke = base.participants[1];
    if (!first || !karaoke) throw new Error("fixture");
    const input = {
      ...base,
      participants: [
        {
          ...first,
          activities: ["study", "karaoke"] as const,
          karaoke_audio: karaoke.karaoke_audio,
        },
        ...base.participants.slice(1),
      ],
    };
    const observation = rehearsalObservation();
    expect(() => assertGoldenAdmission(input, observation)).toThrow();
    const updated = {
      ...observation,
      qualifications: [
        ...observation.qualifications,
        { account_id: first.account_id, persona_id: first.persona_id, activity_key: "karaoke" },
      ],
    };
    expect(() => assertGoldenAdmission(input, updated)).not.toThrow();
    expect(() =>
      assertGoldenAdmission(input, {
        ...updated,
        shares: [...updated.shares, { account_id: first.account_id, persona_id: first.persona_id }],
      }),
    ).toThrow();
    expect(() =>
      assertGoldenAdmission(base, {
        ...observation,
        decisions: observation.decisions.filter((d) => d.reason !== "verification_missing"),
      }),
    ).toThrow();
  });
  test("bounded polling does not call a pending result success or change drawing scope", async () => {
    const input = rehearsalInput();
    const observation = rehearsalObservation();
    let polls = 0;
    const ports = {
      now: () => rehearsalTime,
      sleep: async () => {},
      observe: async () => {
        polls++;
        return { ...observation, unresolved_effect_count: 1 };
      },
    };
    expect(
      await waitForGoldenSettlement(input, { legId: "leg", drawingId: "101" }, ports, 2),
    ).toMatchObject({ state: "reconciliation_required", terminal: false });
    expect(polls).toBe(2);
    await expect(
      waitForGoldenSettlement(input, { legId: "other", drawingId: "101" }, ports, 1),
    ).rejects.toThrow("scope");
    expect(() => evaluateGoldenSettlement(input, observation, rehearsalTime + 61000)).toThrow(
      "fresh",
    );
  });
});
