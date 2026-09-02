export type SealedAttempt = {
  readonly operationId: string;
  readonly renderInputHash: string;
  readonly attemptId: string;
  readonly sealedMasterHash: string;
  readonly probeValid: boolean;
};

export type MasterWinner = Omit<SealedAttempt, "probeValid">;

export type AttemptDisposition =
  | "invalid_probe_disposed"
  | "duplicate_loser_disposed"
  | "divergent_loser_disposed"
  | "replacement_loser_disposed";

export class InMemoryMasterCompareAndSet {
  readonly #winners = new Map<string, MasterWinner>();
  readonly #dispositions = new Map<string, AttemptDisposition>();

  observe(operationId: string, renderInputHash: string) {
    const winner = this.#winners.get(operationId);
    if (!winner) return { kind: "render_required" } as const;
    if (winner.renderInputHash !== renderInputHash) {
      return { kind: "canonical_replacement_rejected", winner } as const;
    }
    return { kind: "winner_observed", winner } as const;
  }

  compareAndSet(attempt: SealedAttempt) {
    if (!attempt.probeValid) {
      this.#dispositions.set(attempt.attemptId, "invalid_probe_disposed");
      return { kind: "invalid_attempt", winner: this.#winners.get(attempt.operationId) } as const;
    }
    const observed = this.observe(attempt.operationId, attempt.renderInputHash);
    if (observed.kind === "canonical_replacement_rejected") {
      this.#dispositions.set(attempt.attemptId, "replacement_loser_disposed");
      return observed;
    }
    if (observed.kind === "winner_observed") {
      const disposition =
        observed.winner.sealedMasterHash === attempt.sealedMasterHash
          ? "duplicate_loser_disposed"
          : "divergent_loser_disposed";
      this.#dispositions.set(attempt.attemptId, disposition);
      return { kind: "loser_disposed", disposition, winner: observed.winner } as const;
    }

    const winner: MasterWinner = {
      operationId: attempt.operationId,
      renderInputHash: attempt.renderInputHash,
      attemptId: attempt.attemptId,
      sealedMasterHash: attempt.sealedMasterHash,
    };
    this.#winners.set(attempt.operationId, winner);
    return { kind: "winner_committed", winner } as const;
  }

  disposition(attemptId: string): AttemptDisposition | undefined {
    return this.#dispositions.get(attemptId);
  }
}

export async function renderUnlessWinner(
  store: InMemoryMasterCompareAndSet,
  input: { readonly operationId: string; readonly renderInputHash: string },
  render: () => Promise<SealedAttempt>,
) {
  const observed = store.observe(input.operationId, input.renderInputHash);
  if (observed.kind !== "render_required") return observed;
  return store.compareAndSet(await render());
}
