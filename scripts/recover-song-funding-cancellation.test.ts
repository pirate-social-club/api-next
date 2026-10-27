import { expect, test } from "bun:test";
import type { Client } from "pg";
import type { FundingCancellationProof } from "../packages/platform-cf/src/song-funding-cancellation-proof.ts";
import {
  cancellationRecoveryOptions,
  completeFundingCancellation,
} from "./recover-song-funding-cancellation.ts";

const transactionHash = `0x${"1".repeat(64)}`;
const options = { contributionId: "contribution", transactionHash, apply: false };
const proof: FundingCancellationProof = {
  proofId: `funding-cancel-v2:84532:${transactionHash}`,
  contributionId: options.contributionId,
  nonceLeaseId: "nonce-lease",
  instructionHash: "a".repeat(64),
  cancellationInstructionHash: "b".repeat(64),
  preparationId: "preparation",
  grantId: "grant",
  chainId: 84532,
  sender: `0x${"a".repeat(40)}`,
  nonce: "7",
  transactionHash,
  blockNumber: "101",
  blockHash: `0x${"2".repeat(64)}`,
  blockTimestamp: "2026-10-18T14:24:00.000Z",
  checkpointBlock: "199",
  checkpointHash: `0x${"3".repeat(64)}`,
  confirmedNonce: "8",
  policyHash: "a".repeat(64),
  requiredConfirmations: 3,
  observedAt: "2026-10-18T14:40:00.000Z",
};
const stored = {
  proof_id: proof.proofId,
  contribution_id: proof.contributionId,
  nonce_lease_id: proof.nonceLeaseId,
  chain_id: proof.chainId,
  sender_address: proof.sender,
  nonce: proof.nonce,
  transaction_hash: proof.transactionHash,
  evidence: proof,
  created_at: proof.observedAt,
};

function database(fail?: string, rows: readonly unknown[] = [{ packet: stored }]) {
  const statements: string[] = [];
  const query = async (text: string) => {
    statements.push(text);
    if (text === fail) throw Error("driver private details");
    return { rows };
  };
  return { statements, db: { query } as Pick<Client, "query"> };
}
test("inspection freshly verifies but performs no database write", async () => {
  const f = database();
  let verified = 0;
  expect(
    (
      await completeFundingCancellation({
        ...f,
        options,
        verify: async () => {
          verified++;
          return proof;
        },
      })
    ).action,
  ).toBe("dry-run");
  expect(verified).toBe(1);
  expect(f.statements).toEqual([]);
});
test("apply verifies afresh and commits exactly one guarded completion", async () => {
  const f = database();
  let verified = 0;
  expect(
    (
      await completeFundingCancellation({
        ...f,
        options: { ...options, apply: true, expectedRevision: "2", brakeRevision: "16" },
        verify: async () => {
          verified++;
          return proof;
        },
      })
    ).action,
  ).toBe("applied");
  expect(verified).toBe(1);
  expect(f.statements).toHaveLength(3);
  expect(f.statements[0]).toBe("BEGIN");
  expect(f.statements[1]).toContain("recover_song_funding_cancellation_v2");
  expect(f.statements[2]).toBe("COMMIT");
});
test("an unknown commit has no rollback, retry or second completion", async () => {
  const f = database("COMMIT");
  await expect(
    completeFundingCancellation({
      ...f,
      options: { ...options, apply: true, expectedRevision: "2", brakeRevision: "16" },
      verify: async () => proof,
    }),
  ).rejects.toThrow("cancellation_completion_outcome_unknown");
  expect(f.statements).toHaveLength(3);
  expect(f.statements).not.toContain("ROLLBACK");
});
test("strict arguments require both explicit revisions only for apply", () => {
  const base = ["--contribution", "contribution", "--transaction", transactionHash];
  expect(cancellationRecoveryOptions(base)).toEqual(options);
  for (const extra of [
    ["--apply"],
    ["--brake-revision", "16"],
    ["--apply", "--brake-revision", "16"],
    ["--contribution", "other"],
    ["--apply", "--apply"],
  ])
    expect(() => cancellationRecoveryOptions([...base, ...extra])).toThrow();
});

test("absent or mismatched completion packets roll back before COMMIT", async () => {
  for (const rows of [
    [],
    [{}],
    [{ packet: null }],
    [{ packet: { ...stored, contribution_id: "foreign" } }],
    [{ packet: { ...stored, evidence: { ...proof, grantId: "other" } } }],
  ]) {
    const f = database(undefined, rows);
    await expect(
      completeFundingCancellation({
        ...f,
        options: { ...options, apply: true, expectedRevision: "2", brakeRevision: "16" },
        verify: async () => proof,
      }),
    ).rejects.toThrow();
    expect(f.statements).not.toContain("COMMIT");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
  }
});
test("idempotent completion can retain its earlier verified finality checkpoint", async () => {
  const f = database(undefined, [
    {
      packet: {
        ...stored,
        evidence: {
          ...proof,
          checkpointBlock: "180",
          checkpointHash: `0x${"4".repeat(64)}`,
          observedAt: "2026-10-18T14:39:00.000Z",
        },
      },
    },
  ]);
  expect(
    (
      await completeFundingCancellation({
        ...f,
        options: { ...options, apply: true, expectedRevision: "2", brakeRevision: "16" },
        verify: async () => proof,
      })
    ).action,
  ).toBe("applied");
});
