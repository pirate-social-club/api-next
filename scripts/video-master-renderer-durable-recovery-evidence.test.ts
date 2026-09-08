import { describe, expect, it } from "bun:test";

import { runDurableRecoveryEvidence } from "./video-master-renderer-durable-recovery-evidence.ts";

const suite =
  process.env.VIDEO_RENDERER_DURABLE_RECOVERY_EVIDENCE === "1" ? describe : describe.skip;

suite("durable renderer recovery across process restarts", () => {
  it("keeps one immutable winner and refuses to reconstruct missing or corrupt bytes", async () => {
    const evidence = await runDurableRecoveryEvidence();

    expect(evidence.postgresImage).toBe("postgres:17");
    expect(evidence.postgresImageId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evidence.recovered).toMatchObject({
      kind: "winner_committed",
      attemptId: "attempt-crash",
    });
    expect(evidence.replayed).toMatchObject({
      kind: "winner_observed",
      attemptId: "attempt-lost",
    });
    expect(evidence.raceResults.map((result) => result.kind).sort()).toEqual([
      "loser_committed",
      "winner_committed",
    ]);
    expect(evidence.cleanupReplay).toMatchObject({ kind: "cleanup_complete", deleted: 1 });
    expect(evidence.corruptObserved).toMatchObject({
      kind: "winner_bytes_corrupt",
      attemptId: "attempt-corrupt",
    });
    expect(evidence.missingObserved).toMatchObject({
      kind: "winner_bytes_missing",
      attemptId: "attempt-missing",
    });

    expect(evidence.winners).toHaveLength(5);
    expect(evidence.invocations).toEqual([
      expect.objectContaining({ operation_id: "operation-corrupt", count: 1 }),
      expect.objectContaining({ operation_id: "operation-crash", count: 1 }),
      expect.objectContaining({ operation_id: "operation-lost", count: 1 }),
      expect.objectContaining({ operation_id: "operation-missing", count: 1 }),
      expect.objectContaining({ operation_id: "operation-race", count: 2 }),
    ]);
    const lostProcessIds = new Set(
      evidence.processEvents
        .filter(({ operation_id }) => operation_id === "operation-lost")
        .map(({ process_pid }) => process_pid),
    );
    const crashProcessIds = new Set(
      evidence.processEvents
        .filter(({ operation_id }) => operation_id === "operation-crash")
        .map(({ process_pid }) => process_pid),
    );
    expect(lostProcessIds.size).toBe(3);
    expect(crashProcessIds.size).toBe(2);
    expect(evidence.attempts.filter((attempt) => attempt.operationId === "operation-race")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "accepted", disposition: null }),
        expect.objectContaining({ state: "disposed", disposition: "divergent_loser" }),
      ]),
    );
    expect(
      evidence.winnerObjectStates.filter(({ operationId }) =>
        ["operation-crash", "operation-lost", "operation-race"].includes(operationId),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "operation-crash", state: "valid" }),
        expect.objectContaining({ operationId: "operation-lost", state: "valid" }),
        expect.objectContaining({ operationId: "operation-race", state: "valid" }),
      ]),
    );
  }, 30_000);
});
