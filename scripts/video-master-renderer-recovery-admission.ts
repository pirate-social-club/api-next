// Isolated amendment evidence, not a runtime or provider contract.
type AttemptIdentity = { readonly attemptId: string; readonly generation: number };
type StopEvidence =
  | { readonly kind: "lease_expired" }
  | { readonly kind: "unconfirmed" }
  | (AttemptIdentity & {
      readonly kind: "confirmed";
      readonly receipt: string;
      readonly writesDrained: boolean;
    });
type OutputEvidence =
  | { readonly kind: "listing_empty" }
  | { readonly kind: "unknown" }
  | { readonly kind: "present" }
  | (AttemptIdentity & {
      readonly kind: "verified_output";
      readonly objectIdentity: string;
      readonly sha256: string;
      readonly byteLength: number;
      readonly immutable: boolean;
      readonly writeCompleted: boolean;
      readonly integrityVerified: boolean;
      readonly renderInputVerified: boolean;
      readonly probeVerified: boolean;
    })
  | (AttemptIdentity & { readonly kind: "absent"; readonly stopReceipt: string });

export function assessRecoveryAdmission(input: {
  readonly attempt: AttemptIdentity;
  readonly state: "started" | "sealed" | "accepted";
  readonly stop: StopEvidence;
  readonly output: OutputEvidence;
}) {
  if (input.state !== "started") return "integrity_recovery_only";
  const candidate = input.output;
  if (candidate.kind === "present") return "pending_output_resolution";
  if (candidate.kind === "verified_output") {
    if (
      candidate.attemptId !== input.attempt.attemptId ||
      candidate.generation !== input.attempt.generation ||
      candidate.objectIdentity.trim().length === 0 ||
      !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      candidate.byteLength <= 0 ||
      !candidate.immutable ||
      !candidate.writeCompleted ||
      !candidate.integrityVerified ||
      !candidate.renderInputVerified ||
      !candidate.probeVerified
    )
      return "pending_output_resolution";
    return "recover_existing_output";
  }
  const stop = input.stop;
  if (stop.kind !== "confirmed") return "pending_termination";
  if (
    stop.attemptId !== input.attempt.attemptId ||
    stop.generation !== input.attempt.generation ||
    stop.receipt.length === 0 ||
    !stop.writesDrained
  )
    return "pending_termination";
  const output = input.output;
  if (
    output.kind !== "absent" ||
    output.attemptId !== input.attempt.attemptId ||
    output.generation !== input.attempt.generation ||
    output.stopReceipt !== stop.receipt
  )
    return "pending_output_resolution";
  return "eligible_for_atomic_abandonment";
}
