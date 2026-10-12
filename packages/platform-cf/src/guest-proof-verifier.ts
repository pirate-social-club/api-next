import {
  ControlPlaneDb,
  type ControlPlaneError,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import type {
  GuestCredentialVerifier,
  ProvedGuestCredential,
} from "@pirate/application/guest-participation-authority";
import type {
  GuestLearningLeaseObservation,
  GuestProofInput,
  GuestProofSnapshot,
  GuestProofSnapshotReader,
} from "@pirate/application/guest-proof-verifier";
import { GuestAttachmentIntentIdV1, GuestCredentialIdV1, GuestInstantV1 } from "@pirate/contracts";
import { Effect, type Layer, Schema } from "effect";

const Owner = Schema.String.check(
  Schema.isPattern(/^owner_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
);
const Origin = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value
        ? undefined
        : "Expected canonical HTTPS origin";
    } catch {
      return "Expected canonical HTTPS origin";
    }
  }),
);
const Provenance = Schema.Struct({
  credentialId: GuestCredentialIdV1,
  credentialSourceOwnerId: Owner,
  effectiveOwnerId: Owner,
  origin: Origin,
});
const Credential = Schema.Struct({
  ...Provenance.fields,
  ownerId: Owner,
  state: Schema.Literals(["pending_bootstrap", "pending_successor", "confirmed", "revoked"]),
  leaseUntil: Schema.NullOr(GuestInstantV1),
  pendingExpiresAt: GuestInstantV1,
  predecessorCredentialId: Schema.NullOr(GuestCredentialIdV1),
  pendingActive: Schema.Boolean,
  learningLeaseActive: Schema.Boolean,
}).check(
  Schema.makeFilter((c) => {
    if (c.ownerId !== c.effectiveOwnerId) return "Invalid effective owner projection";
    if (c.state === "confirmed" && c.leaseUntil === null) return "Missing confirmed lease";
    if (c.state === "pending_bootstrap" && c.predecessorCredentialId !== null)
      return "Invalid bootstrap lineage";
    if (c.state === "pending_successor" && c.predecessorCredentialId === null)
      return "Missing successor lineage";
    if (
      (c.state === "pending_bootstrap" || c.state === "pending_successor") &&
      c.leaseUntil !== null
    )
      return "Invalid pending lease";
    if (c.pendingActive && c.state !== "pending_bootstrap" && c.state !== "pending_successor")
      return "Invalid pending authority";
    if (c.learningLeaseActive && c.state !== "confirmed") return "Invalid learning authority";
    return undefined;
  }),
);
const Intent = Schema.Struct({
  intentId: GuestAttachmentIntentIdV1,
  credentialId: GuestCredentialIdV1,
  credentialSourceOwnerId: Owner,
  effectiveOwnerId: Owner,
  ownerId: Owner,
  origin: Origin,
  state: Schema.Literals(["awaiting_account", "awaiting_confirmation", "superseded", "expired"]),
  expiresAt: GuestInstantV1,
  active: Schema.Boolean,
}).check(
  Schema.makeFilter((i) =>
    i.active &&
    ((i.state !== "awaiting_account" && i.state !== "awaiting_confirmation") ||
      i.ownerId !== i.effectiveOwnerId)
      ? "Invalid live intent authority"
      : undefined,
  ),
);
const Snapshot = Schema.Struct({
  origin: Origin,
  databaseObservedAt: GuestInstantV1,
  provedCredentials: Schema.Array(Credential).check(Schema.isMaxLength(16)),
  provedIntents: Schema.Array(Intent).check(Schema.isMaxLength(16)),
});
const SnapshotRow = Schema.Struct({ snapshot: Snapshot });
const Lease = Schema.Struct({
  credential: Provenance,
  state: Schema.Literal("confirmed"),
  leaseUntil: GuestInstantV1,
  databaseObservedAt: GuestInstantV1,
  active: Schema.Boolean,
});
const LeaseRow = Schema.Struct({ observation: Schema.NullOr(Lease) });
const invalidProjection = (label: string) =>
  new ControlPlaneStatementFailed({
    label,
    sqlState: null,
    constraint: null,
    outcomeCertainty: "completed",
  });

export function makeControlPlaneGuestProofAuthority(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): Readonly<{
  snapshotReader: GuestProofSnapshotReader;
  verifier: GuestCredentialVerifier;
  observeLearningLease: (
    proof: Pick<ProvedGuestCredential, "origin" | "credentialId" | "ownerId">,
  ) => Effect.Effect<GuestLearningLeaseObservation | null, ControlPlaneError>;
  /** Directly matches the installed browser adapter callback without a frozen port change. */
  isLearningLeaseActive: (proof: ProvedGuestCredential) => Promise<boolean>;
}> {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const read = Effect.fn("GuestProofAuthority.read")(function* (input: GuestProofInput) {
    const db = yield* ControlPlaneDb;
    // execute() defaults to unknown rows: the generic DB type is not validation.
    const response = yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute({
          label: "guest-proof.snapshot.read-limits",
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        return yield* transaction.execute({
          label: "guest-proof.snapshot.read",
          text: "SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,$3::jsonb,$4) AS snapshot",
          values: [
            input.origin,
            JSON.stringify(input.credentialProofs),
            JSON.stringify(input.intentProofs),
            input.cleanup,
          ],
          readonly: true,
        });
      }),
    );
    return yield* Effect.try({
      try: (): GuestProofSnapshot => {
        if (response.rows.length !== 1) throw new Error();
        const snapshot = Schema.decodeUnknownSync(SnapshotRow, { onExcessProperty: "error" })(
          response.rows[0],
        ).snapshot;
        const maximum = input.cleanup ? 16 : 4;
        const credentialIds = new Set(input.credentialProofs.map((p) => p.credentialId));
        const intentIds = new Set(input.intentProofs.map((p) => p.intentId));
        if (
          snapshot.origin !== input.origin ||
          snapshot.provedCredentials.length > maximum ||
          snapshot.provedIntents.length > maximum ||
          new Set(snapshot.provedCredentials.map((p) => p.credentialId)).size !==
            snapshot.provedCredentials.length ||
          new Set(snapshot.provedIntents.map((p) => p.intentId)).size !==
            snapshot.provedIntents.length ||
          snapshot.provedCredentials.some(
            (p) => p.origin !== input.origin || !credentialIds.has(p.credentialId),
          ) ||
          snapshot.provedIntents.some(
            (p) => p.origin !== input.origin || !intentIds.has(p.intentId),
          )
        )
          throw new Error();
        return snapshot;
      },
      // Never retain the parser error, input, row, secret/digest, query values or cause.
      catch: () => invalidProjection("guest-proof.snapshot.decode"),
    });
  });
  const observe = Effect.fn("GuestProofAuthority.observeLearningLease")(function* (
    proof: Pick<ProvedGuestCredential, "origin" | "credentialId" | "ownerId">,
  ) {
    const db = yield* ControlPlaneDb;
    const response = yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.execute({
          label: "guest-proof.learning-lease.read-limits",
          text: "SELECT set_config('transaction_timeout','3s',true),set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)",
          values: [],
          readonly: true,
        });
        return yield* transaction.execute({
          label: "guest-proof.learning-lease.read",
          text: "SELECT read_guest_learning_lease_observation_v1($1,$2,$3) AS observation",
          values: [proof.origin, proof.credentialId, proof.ownerId],
          readonly: true,
        });
      }),
    );
    return yield* Effect.try({
      try: (): GuestLearningLeaseObservation | null => {
        if (response.rows.length !== 1) throw new Error();
        const observed = Schema.decodeUnknownSync(LeaseRow, { onExcessProperty: "error" })(
          response.rows[0],
        ).observation;
        if (
          observed !== null &&
          (observed.credential.credentialId !== proof.credentialId ||
            observed.credential.origin !== proof.origin ||
            observed.credential.effectiveOwnerId !== proof.ownerId)
        )
          throw new Error();
        return observed;
      },
      catch: () => invalidProjection("guest-proof.learning-lease.decode"),
    });
  });
  const snapshotReader: GuestProofSnapshotReader = { read: (input) => provide(read(input)) };
  return {
    snapshotReader,
    // Frozen117 compatibility is an explicit whitelist projection, never {...snapshot}.
    verifier: {
      verify: (input) =>
        snapshotReader.read(input).pipe(
          Effect.map((snapshot) => ({
            origin: snapshot.origin,
            provedCredentials: snapshot.provedCredentials.map((p) => ({
              ownerId: p.effectiveOwnerId,
              credentialId: p.credentialId,
              origin: p.origin,
              state: p.state,
              leaseUntil: p.leaseUntil,
              pendingExpiresAt: p.pendingExpiresAt,
              predecessorCredentialId: p.predecessorCredentialId,
            })),
            provedIntents: snapshot.provedIntents.map((p) => ({
              intentId: p.intentId,
              ownerId: p.ownerId,
              credentialId: p.credentialId,
              origin: p.origin,
              state: p.state,
              expiresAt: p.expiresAt,
            })),
          })),
        ),
    },
    observeLearningLease: (proof) => provide(observe(proof)),
    isLearningLeaseActive: async (proof) => {
      if (proof.state !== "confirmed" || proof.leaseUntil === null) return false;
      const observed = await Effect.runPromise(provide(observe(proof)));
      return observed?.active === true;
    },
  };
}
