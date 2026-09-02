import { describe, expect, it } from "bun:test";

import {
  InMemoryMasterCompareAndSet,
  renderUnlessWinner,
  type SealedAttempt,
} from "./video-master-renderer-attempt-policy.ts";

const attempt = (overrides: Partial<SealedAttempt> = {}): SealedAttempt => ({
  operationId: "operation-1",
  renderInputHash: "input-a",
  attemptId: "attempt-1",
  sealedMasterHash: "master-a",
  probeValid: true,
  ...overrides,
});

describe("video master attempt winner policy", () => {
  it("recovers an observable winner after a lost response without reinvoking render", async () => {
    const store = new InMemoryMasterCompareAndSet();
    let invocations = 0;
    const render = async () => {
      invocations += 1;
      return attempt();
    };

    const committedButResponseLost = await renderUnlessWinner(
      store,
      { operationId: "operation-1", renderInputHash: "input-a" },
      render,
    );
    expect(committedButResponseLost.kind).toBe("winner_committed");

    const replay = await renderUnlessWinner(
      store,
      { operationId: "operation-1", renderInputHash: "input-a" },
      render,
    );
    expect(replay.kind).toBe("winner_observed");
    expect(invocations).toBe(1);
  });

  it("disposes duplicate and divergent losing outputs without replacing the winner", () => {
    const store = new InMemoryMasterCompareAndSet();
    expect(store.compareAndSet(attempt()).kind).toBe("winner_committed");

    const duplicate = store.compareAndSet(attempt({ attemptId: "attempt-2" }));
    expect(duplicate.kind).toBe("loser_disposed");
    expect(store.disposition("attempt-2")).toBe("duplicate_loser_disposed");

    const divergent = store.compareAndSet(
      attempt({ attemptId: "attempt-3", sealedMasterHash: "master-divergent" }),
    );
    expect(divergent.kind).toBe("loser_disposed");
    expect(store.disposition("attempt-3")).toBe("divergent_loser_disposed");
    expect(store.observe("operation-1", "input-a")).toMatchObject({
      kind: "winner_observed",
      winner: { attemptId: "attempt-1", sealedMasterHash: "master-a" },
    });
  });

  it("rejects canonical replacement and disposes a probe-invalid attempt", () => {
    const store = new InMemoryMasterCompareAndSet();
    expect(store.compareAndSet(attempt()).kind).toBe("winner_committed");
    expect(store.observe("operation-1", "input-b").kind).toBe("canonical_replacement_rejected");
    expect(
      store.compareAndSet(
        attempt({
          renderInputHash: "input-b",
          attemptId: "attempt-replacement",
          sealedMasterHash: "master-replacement",
        }),
      ).kind,
    ).toBe("canonical_replacement_rejected");
    expect(store.disposition("attempt-replacement")).toBe("replacement_loser_disposed");

    const invalid = store.compareAndSet(
      attempt({ operationId: "operation-2", attemptId: "attempt-invalid", probeValid: false }),
    );
    expect(invalid.kind).toBe("invalid_attempt");
    expect(store.disposition("attempt-invalid")).toBe("invalid_probe_disposed");
  });
});
