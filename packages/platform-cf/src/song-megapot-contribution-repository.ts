import { Effect, type Layer, Schema } from "effect";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "../../application/src/ports.ts";
import {
  type ContributionState,
  digestFundingPreimageV2,
  type FundingAdmission,
  type FundingCommandReceipt,
  type RecoveryAuthority,
  SongContributionFailure,
  type SongContributionPorts,
  type SongContributionReadPorts,
  type SongContributionTransaction,
  type SongFundingRecoveryWorkPolicy,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import * as C from "../../contracts/src/rewards-song-contributions-v2.ts";
import { HashV2, IdV2, KeyV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import { withRetainedControlPlaneCommandTransaction } from "./control-plane-command-transaction.ts";
import { validateMegapotV2DeploymentAttestation } from "./megapot-v2.ts";
import {
  type FundingPrincipalEvidence,
  FundingRecoveryEvidence,
  type FundingRecoverySource,
  type makeRewardFundingReceiptDiscovery,
  recoveryEvidencePreimage,
} from "./reward-funding-receipt-discovery.ts";
import {
  loadRewardFundingWalletNonceOwnerIn,
  reserveRewardFundingWalletNonceIn,
} from "./reward-wallet-nonce-authority.ts";
import { instantiateSharedSongRewardPolicyIn } from "./shared-song-megapot-production.ts";

type CommandIdentity = Parameters<SongContributionPorts["transaction"]>[0];

const CommandIdentity = Schema.Struct({
  accountId: IdV2,
  communityId: IdV2,
  postId: IdV2,
  contributionId: Schema.NullOr(IdV2),
  operation: Schema.Literals([
    "CreateSongMegapotContributionV2",
    "ClaimSongMegapotContributionSubmissionV2",
    "ObserveSongMegapotContributionV2",
    "RecoverSongMegapotContributionV2",
    "PrepareSongMegapotContributionCancellationV2",
  ]),
  key: KeyV2,
  hash: HashV2,
}).check(
  Schema.makeFilter((i) =>
    (i.operation === "CreateSongMegapotContributionV2") === (i.contributionId === null)
      ? undefined
      : "Contribution identity does not match operation",
  ),
);

/** Shared transaction boundary used by the concrete CP3/CP5 ports below.
 * Identity must come from the authenticated application command, never request JSON.
 * Session/private-read/Origin-CSRF/rate checks remain before this boundary.
 *
 * The first domain lock is (account, operation, key). Path and body hash are
 * deliberately excluded so conflicting same-key requests serialize together.
 * The callback must re-read the original owned command and compare its hash
 * before any current admission guards, then take further locks in V5 order.
 * The concrete adapter uses the existing command/receipt tables and shared
 * nonce authority. This boundary introduces no second allocator/interpreter.
 *
 * Reuses accepted withTransaction: one callback, known commit before success.
 * No retry or error remapping. Capture callback and transaction Causes before
 * interruption restoration can replace either. The mask covers only accepted
 * bounded acquisition/release and capture; restore keeps the lock and callback
 * cancellable. Combine retained failures with any pending external interruption.
 * A future business adapter must retain unknown outcomes on the original key;
 * it cannot treat a read miss/error, timeout or COMMIT failure as allocation:none.
 */
export const withSongMegapotContributionTransaction = Effect.fn(
  "SongMegapotContributionRepository.withTransaction",
)(function* <A>(
  identity: CommandIdentity,
  use: (
    transaction: ControlPlaneTransaction,
  ) => Effect.Effect<A, SongContributionFailure | ControlPlaneError>,
): Effect.fn.Return<A, SongContributionFailure | ControlPlaneError, ControlPlaneDb> {
  const decoded = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(CommandIdentity, { onExcessProperty: "error" })(identity),
    catch: () => new SongContributionFailure({ code: "invalid_request" }),
  });
  return yield* withRetainedControlPlaneCommandTransaction((transaction) =>
    Effect.gen(function* () {
      yield* transaction.execute({
        label: "song-megapot-contribution.command.lock",
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: [
          JSON.stringify([
            "song-megapot-contribution-command-v2",
            decoded.accountId,
            decoded.operation,
            decoded.key,
          ]),
        ],
        readonly: false,
      });
      return yield* use(transaction);
    }),
  );
});

const natural = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const positive = natural.check(Schema.isGreaterThan(0));
const recoveryWorkPolicySchema = Schema.Struct({
  maxAttempts: positive,
  leaseMs: positive,
  maximumBlocks: positive,
  maximumLogs: positive,
  receipt: Schema.Struct({
    policyHash: C.HashV2,
    requiredConfirmations: positive,
    maximumClockSkewMs: natural,
    maximumObservationAgeMs: positive,
  }),
});
const capacityProfile = Schema.Struct({
  maxDrawings: positive,
  reservationMs: positive,
  safetyMarginMs: natural,
  maximumWitnessAgeMs: positive,
  validUntil: natural,
  attestationValidUntil: natural,
  priceCeilingAtomic: Schema.BigIntFromString,
  minimumAtomic: Schema.BigIntFromString,
});
const limits = Schema.Struct({
  reconciliation: Schema.optional(recoveryWorkPolicySchema),
  maxActiveAccount: positive,
  maxActiveAccountLeg: positive,
  maxLegLiabilities: positive,
  maxAdmittedLeg: positive,
  maxAdmittedAccountLeg: positive,
  workPerInstruction: positive,
  economicsPolicyHash: C.HashV2,
  gasPolicyHash: C.HashV2,
  custodyPolicyHash: C.HashV2,
});
const schedule = Schema.Struct({
  observedAt: natural,
  validUntil: natural,
  ruleHash: C.HashV2,
  priceRuleHash: C.HashV2,
  recurrenceProven: Schema.Boolean,
  rows: Schema.Array(
    Schema.Struct({
      id: C.UIntV2,
      drawingTime: natural,
      entryCutoff: natural,
      purchaseDeadline: natural,
      priceAtomic: Schema.BigIntFromString,
      proof: Schema.Literals(["initialized_state", "attested_recurrence"]),
      state: Schema.Literals(["uncommitted", "committed", "settled", "cancelled"]),
      reservedCostAtomic: Schema.BigIntFromString,
    }),
  ),
});
const budgetSchema = Schema.Struct({
  funded: Schema.BigIntFromString,
  spent: Schema.BigIntFromString,
  committedPurchases: Schema.BigIntFromString,
  refunded: Schema.BigIntFromString,
  otherObligations: Schema.BigIntFromString,
  liveInboundReservations: Schema.BigIntFromString,
});
const stateSchema = Schema.Struct({
  owner: C.OwnedActorV2,
  receipt: C.ContributionReceiptV2,
  anchorBlockHash: C.TxHashV2,
  revision: natural,
  fundingState: Schema.Literals([
    "instruction_issued",
    "submission_claimed",
    "broadcast_unknown",
    "confirming",
    "expired_reconciling",
    "pool_credited",
    "late_principal_owed",
    "nonce_closed_no_principal",
  ]),
  effectiveDeadline: C.InstantV2,
  nonceFinalized: Schema.Boolean,
  fundingGrant: Schema.NullOr(C.SubmissionClaimReceiptV2),
  cancellationGrant: Schema.NullOr(C.SubmissionClaimReceiptV2),
  cancellationHead: Schema.NullOr(C.CancellationReceiptV2),
  preparationsUsed: natural,
});
const commandSchema = Schema.Struct({
  requestHash: C.HashV2,
  receipt: Schema.Union([
    C.ContributionReceiptV2,
    C.SubmissionClaimReceiptV2,
    C.CancellationReceiptV2,
    C.ObservationReceiptV2,
    C.RecoveryReceiptV2,
  ]),
});
const recoverySchema = Schema.Struct({
  currentEvidence: Schema.optional(Schema.NullOr(FundingRecoveryEvidence)),
  policy: Schema.NullOr(C.CancellationRecoveryPolicyV2),
  attestationId: C.IdV2,
  attestationHash: C.HashV2,
  attestationValidUntil: C.InstantV2,
  originalWalletStillOwned: Schema.Boolean,
  currentSigningRefusal: Schema.NullOr(C.ErrorV2.fields.code),
  boundedWorkAvailable: Schema.Boolean,
});
const witnessSchema = Schema.Struct({
  id: C.HashV2,
  chainId: positive,
  senderAddress: C.AddressV2,
  observedAtMs: natural,
  confirmed: Schema.Struct({
    nonce: Schema.BigIntFromString,
    blockNumber: Schema.BigIntFromString,
    blockHash: C.HashV2,
  }),
  pending: Schema.Struct({
    nonce: Schema.BigIntFromString,
    baseBlockNumber: Schema.BigIntFromString,
    baseBlockHash: C.HashV2,
  }),
});
const decodeRow = <S extends Schema.ConstraintDecoder<unknown>>(s: S, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(value),
    catch: () => new SongContributionFailure({ code: "outcome_unknown" }),
  });
const mapStorage = <A, E, R>(e: Effect.Effect<A, E | ControlPlaneError, R>) =>
  e.pipe(
    Effect.mapError((error) => {
      if (error instanceof SongContributionFailure) return error;
      const state =
        typeof error === "object" && error !== null && "sqlState" in error ? error.sqlState : null;
      const codes: Record<string, SongContributionFailure["code"]> = {
        PCV02: "not_found",
        PCV03: "idempotency_conflict",
        PCV04: "work_budget_exhausted",
        PCV05: "policy_unavailable",
        PCV06: "lifecycle_changed",
        PCV07: "invalid_request",
        PCV08: "effect_limit",
        PCV09: "submission_already_claimed",
        PCV10: "recovery_required",
        PCV11: "receipt_mismatch",
        PCV12: "cancellation_recovery_unavailable",
        PWN01: "persona_not_owned",
        PWN02: "wallet_nonce_busy",
        PWN03: "wallet_nonce_busy",
        PWN04: "observation_stale",
        PR001: "paused",
      };
      return new SongContributionFailure({
        code: typeof state === "string" ? (codes[state] ?? "outcome_unknown") : "outcome_unknown",
        underlying: error,
      });
    }),
  );
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));

/** Real CP3/CP5 SQL persistence. Auth is the actual HTTP/session boundary's
 * capability, supplied explicitly; no browser actor/nonce/policy is trusted.
 * HTTP composition supplies the actual session capability and feature posture.
 * Live role mapping and CP2 objective construction remain separate gates.
 */
export function makeControlPlaneSongContributionPorts(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  authorization: Pick<SongContributionPorts, "authorize">,
  runtime: Readonly<{ rewardsEnabled: boolean }>,
): SongContributionPorts {
  const provided = <A, E>(e: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapStorage(e.pipe(Effect.provide(layer)));
  const call = (
    db: ControlPlaneTransaction,
    label: string,
    text: string,
    values: readonly unknown[],
    readonly = false,
  ) =>
    db
      .execute<{ packet: unknown }>({ label, text, values, readonly })
      .pipe(
        Effect.flatMap((result) =>
          result.rows.length !== 1
            ? Effect.fail(new SongContributionFailure({ code: "outcome_unknown" }))
            : Effect.succeed(result.rows[0]?.packet),
        ),
      );
  const lookupIn = (db: ControlPlaneTransaction, i: CommandIdentity) =>
    Effect.gen(function* () {
      const value = yield* call(
        db,
        "song-contribution.command.read",
        "SELECT load_song_contribution_command_v2($1,$2,$3) AS packet",
        [i.accountId, i.operation, i.key],
        true,
      );
      if (value === null) return null;
      const command = yield* decodeRow(commandSchema, value);
      const objects: Record<CommandIdentity["operation"], FundingCommandReceipt["object"]> = {
        CreateSongMegapotContributionV2: "song_megapot_contribution_command_receipt",
        ClaimSongMegapotContributionSubmissionV2: "contribution_submission_claim_receipt",
        PrepareSongMegapotContributionCancellationV2: "contribution_cancellation_command_receipt",
        ObserveSongMegapotContributionV2: "contribution_observation_command_receipt",
        RecoverSongMegapotContributionV2: "contribution_recovery_command_receipt",
      };
      if (
        command.receipt.object !== objects[i.operation] ||
        command.receipt.request_hash !== command.requestHash
      )
        return yield* new SongContributionFailure({ code: "outcome_unknown" });
      return command;
    });
  const ports: SongContributionPorts = {
    authorize: authorization.authorize,
    lookup: (i) =>
      provided(
        Effect.gen(function* () {
          return yield* lookupIn(yield* ControlPlaneDb, i);
        }),
      ),
    // Already-persisted observer witnesses are re-read under allocation locks.
    // This bounded read checks database availability, never rejects a replay for
    // stale/missing business facts and never allocates a quote/slot or nonce.
    preflight: () =>
      provided(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          yield* db.execute({
            label: "song-contribution.preflight",
            text: "SELECT transaction_timestamp()",
            values: [],
            readonly: true,
          });
        }),
      ),
    transaction: (identity, use) =>
      provided(
        withSongMegapotContributionTransaction(identity, (db) =>
          Effect.gen(function* () {
            let admissionPacket: typeof packetSchema.Type | undefined;
            let sampled: string | undefined;
            const owned = () =>
              Effect.gen(function* () {
                const value = yield* call(
                  db,
                  "song-contribution.owned.read",
                  "SELECT load_owned_song_contribution_v2($1::jsonb) AS packet",
                  [json(identity)],
                  true,
                );
                if (value === null)
                  return yield* new SongContributionFailure({ code: "not_found" });
                return yield* decodeRow(stateSchema, value);
              });
            const tx: SongContributionTransaction = {
              lookup: () => mapStorage(lookupIn(db, identity)),
              now: () =>
                mapStorage(
                  Effect.gen(function* () {
                    if (sampled !== undefined) return sampled;
                    const value = yield* call(
                      db,
                      "song-contribution.clock",
                      "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS packet",
                      [],
                      true,
                    );
                    sampled = yield* decodeRow(C.InstantV2, value);
                    return sampled;
                  }),
                ),
              id: (kind) => Effect.succeed(`${kind}:${crypto.randomUUID()}`),
              instantiateRewardPolicy: (offerId, templateHash) =>
                mapStorage(
                  Effect.gen(function* () {
                    if (admissionPacket === undefined)
                      return yield* new SongContributionFailure({ code: "recovery_required" });
                    return yield* instantiateSharedSongRewardPolicyIn(
                      db,
                      identity,
                      admissionPacket.snapshot.snapshot_id,
                      offerId,
                      templateHash,
                    );
                  }),
                ),
              ownedContribution: () => mapStorage(owned()),
              fundingAdmission: (request) =>
                mapStorage(
                  Effect.gen(function* () {
                    // This runs only after the locked same-key lookup. Turning
                    // the feature off never suppresses immutable receipt replay.
                    if (!runtime.rewardsEnabled)
                      return yield* new SongContributionFailure({ code: "paused" });
                    const raw = yield* call(
                      db,
                      "song-contribution.context.lock",
                      "SELECT lock_song_contribution_context_v2($1::jsonb,$2) AS packet",
                      [json(identity), request.expected_context_hash],
                    );
                    const packet = yield* decodeRow(packetSchema, raw);
                    admissionPacket = packet;
                    const { snapshot, slot, profile, witness, counts, work } = packet;
                    const reference = snapshot.context.context_ref;
                    if (
                      snapshot.profile_id !== profile.profile_id ||
                      profile.profile_id !== reference.profile_id ||
                      profile.profile_hash !== reference.profile_hash ||
                      snapshot.witness_id !== witness.witness_id ||
                      witness.witness_id !== reference.schedule_witness_id ||
                      witness.profile_id !== profile.profile_id ||
                      snapshot.slot_id !== slot.slot_id ||
                      slot.slot_id !== reference.slot_id ||
                      snapshot.context_hash !== request.expected_context_hash ||
                      witness.nonce_witness.confirmed.blockNumber.toString() !==
                        snapshot.context.schedule.anchor.block_number ||
                      witness.nonce_witness.confirmed.blockHash !==
                        snapshot.context.schedule.anchor.block_hash.slice(2)
                    )
                      return yield* new SongContributionFailure({
                        code: "quote_reference_invalid",
                      });
                    const head = yield* db.execute<{
                      highest_nonce: string | null;
                      blocked_reason: string | null;
                    }>({
                      label: "song-contribution.nonce.head",
                      text: "SELECT highest_nonce::text,blocked_reason FROM reward_wallet_nonce_context_v2($1,$2,NULL)",
                      values: [snapshot.context.chain_id, snapshot.context.actor.sender_address],
                      readonly: false,
                    });
                    if (head.rows.length !== 1)
                      return yield* new SongContributionFailure({ code: "outcome_unknown" });
                    const now = Date.parse(yield* tx.now());
                    const totalsRow = packet.principal;
                    return {
                      context: snapshot.context,
                      actor: snapshot.context.actor,
                      currentTarget: slot.target,
                      currentTerms: slot.terms,
                      currentSlotGeneration: slot.generation,
                      originEmptyGeneration: slot.terms?.origin_slot_generation ?? null,
                      capacityProfile: profile.accepted ? profile.capacity_profile : null,
                      schedule: witness.schedule,
                      budget: {
                        ...snapshot.budget,
                        funded: totalsRow.funded,
                        liveInboundReservations: totalsRow.reserved,
                      },
                      costsReconciled:
                        snapshot.costs_reconciled && snapshot.budget.funded === totalsRow.funded,
                      policy: profile.accepted ? profile.policy : null,
                      counters: {
                        ...counts,
                        accountWorkRemaining: work?.account ?? 0,
                        legWorkRemaining: work?.leg ?? 0,
                        globalWorkRemaining: work?.global ?? 0,
                        refundEnvelopeReady: profile.accepted && snapshot.context.fees.gas_ready,
                        unresolvedV1Wallet: head.rows[0]?.blocked_reason === "unknown_v1_funding",
                      },
                      refusal:
                        slot.status !== "open"
                          ? "lifecycle_changed"
                          : !slot.reward_policy_ready
                            ? "mixed_objective_unavailable"
                            : snapshot.refusal,
                      confirmedNonce: witness.nonce_witness.confirmed.nonce.toString(),
                      pendingNonce: witness.nonce_witness.pending.nonce.toString(),
                      nonceWitnessFresh:
                        now >= witness.nonce_witness.observedAtMs &&
                        now - witness.nonce_witness.observedAtMs <= profile.nonce_policy.maxAgeMs,
                      sharedNonceLeaseAvailable: head.rows[0]?.blocked_reason === null,
                    } satisfies FundingAdmission;
                  }),
                ),
              recoveryAuthority: (state) =>
                mapStorage(
                  Effect.gen(function* () {
                    // Lock account -> slot -> original shared nonce before work/profile.
                    const rows = yield* db.execute<{ packet: unknown }>({
                      label: "song-contribution.recovery.authority",
                      text: "SELECT load_song_contribution_recovery_v2($1::jsonb) AS packet",
                      values: [json(identity)],
                      readonly: false,
                    });
                    const authority = yield* decodeRow(recoverySchema, rows.rows[0]?.packet);
                    const i = state.receipt.instruction;
                    const lease = yield* loadRewardFundingWalletNonceOwnerIn(db, {
                      leaseId: state.receipt.reservation.nonce_lease_id,
                      ownerId: state.receipt.contribution_id,
                      commandId: state.receipt.command_id,
                      accountId: state.owner.account_id,
                      personaId: state.owner.persona_id,
                      walletAssignmentId: i.wallet_assignment_id,
                      chainId: i.chain_id,
                      senderAddress: i.from,
                      requestHash: state.receipt.request_hash,
                    });
                    const e = authority.currentEvidence;
                    const now = e === undefined || e === null ? null : yield* tx.now();
                    const current =
                      now !== null &&
                      e !== undefined &&
                      e !== null &&
                      e.contributionId === state.receipt.contribution_id &&
                      e.instructionHash === i.instruction_hash &&
                      e.attestationId === i.attestation_id &&
                      e.attestationHash === i.attestation_hash &&
                      e.sender === i.from &&
                      e.chainId === i.chain_id &&
                      e.walletAssignmentId === i.wallet_assignment_id &&
                      e.confirmedNonce === i.nonce &&
                      e.observedAt <= now &&
                      now < e.validUntil &&
                      e.stateRevision <= state.revision &&
                      (yield* digestFundingPreimageV2(recoveryEvidencePreimage(e))) ===
                        e.witnessHash;
                    return {
                      ...authority,
                      policy: current && runtime.rewardsEnabled ? authority.policy : null,
                      currentSigningRefusal: runtime.rewardsEnabled
                        ? authority.currentSigningRefusal
                        : "paused",
                      originalWalletStillOwned:
                        authority.originalWalletStillOwned && lease !== null,
                    } satisfies RecoveryAuthority;
                  }),
                ),
              create: (state, _admission) =>
                mapStorage(
                  Effect.gen(function* () {
                    const p = admissionPacket;
                    if (p === undefined)
                      return yield* new SongContributionFailure({ code: "recovery_required" });
                    const s = yield* decodeRow(stateSchema, state);
                    const i = s.receipt.instruction;
                    if (p.slot.target === null) {
                      yield* db.execute({
                        label: "shared-song.pot.bind",
                        text: "SELECT bind_initial_shared_song_pot_v2($1::jsonb,$2,$3::jsonb)",
                        values: [json(identity), p.snapshot.snapshot_id, json(s)],
                        readonly: false,
                      });
                    }
                    yield* reserveRewardFundingWalletNonceIn(db, {
                      owner: {
                        leaseId: s.receipt.reservation.nonce_lease_id,
                        ownerId: s.receipt.contribution_id,
                        commandId: s.receipt.command_id,
                        accountId: identity.accountId,
                        personaId: s.owner.persona_id,
                        walletAssignmentId: i.wallet_assignment_id,
                        chainId: i.chain_id,
                        senderAddress: i.from,
                        requestHash: identity.hash,
                      },
                      nonce: BigInt(i.nonce),
                      nowMs: Date.parse(yield* tx.now()),
                      policy: p.profile.nonce_policy,
                      witness: p.witness.nonce_witness,
                    });
                    yield* db.execute({
                      label: "song-contribution.create",
                      text: "SELECT create_song_contribution_v2($1::jsonb,$2::jsonb,$3)",
                      values: [json(identity), json(s), p.snapshot.snapshot_id],
                      readonly: false,
                    });
                  }),
                ),
              update: (before, after, command) =>
                mapStorage(
                  Effect.gen(function* () {
                    const b = yield* decodeRow(stateSchema, before);
                    const s = yield* decodeRow(stateSchema, after);
                    const r = yield* decodeRow(commandSchema, command);
                    yield* db.execute({
                      label: "song-contribution.command.update",
                      text: "SELECT update_song_contribution_command_v2($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb)",
                      values: [json(identity), json(b), json(s), json(r.receipt)],
                      readonly: false,
                    });
                  }),
                ),
              recordReconciliationRequest: (state, command, hint) =>
                mapStorage(
                  Effect.gen(function* () {
                    if (state.owner.account_id !== identity.accountId)
                      return yield* new SongContributionFailure({ code: "not_found" });
                    const r = yield* decodeRow(commandSchema, command);
                    yield* db.execute({
                      label: "song-contribution.reconciliation.enqueue",
                      text: "SELECT enqueue_song_contribution_reconciliation_v2($1::jsonb,$2::jsonb,$3::jsonb)",
                      values: [json(identity), json(r.receipt), json(hint)],
                      readonly: false,
                    });
                  }),
                ),
            };
            return yield* use(tx);
          }),
        ),
      ),
  };
  return ports;
}

/** Real bounded own-scope SQL reads, independent of current funding admission.
 * These functions expose no arbitrary SELECT or allocation capability to HTTP.
 */
export function makeControlPlaneSongContributionReadPorts(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  authorization: Pick<SongContributionReadPorts, "authorize">,
  runtime: Readonly<{ rewardsEnabled: boolean }>,
): SongContributionReadPorts {
  const read = (label: string, text: string, values: readonly unknown[]) =>
    mapStorage(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<{ packet: unknown }>({
          label,
          text,
          values,
          readonly: true,
        });
        if (result.rows.length !== 1 || result.rows[0]?.packet === undefined)
          return yield* new SongContributionFailure({ code: "outcome_unknown" });
        return result.rows[0].packet;
      }).pipe(Effect.provide(layer)),
    );
  return {
    authorize: authorization.authorize,
    context: (scope, accountId, personaId) =>
      read(
        "song-contribution.context.read",
        "SELECT read_song_contribution_context_v2($1::jsonb,$2) AS packet",
        [json({ ...scope, accountId }), personaId],
      ).pipe(
        Effect.flatMap((packet) =>
          Effect.gen(function* () {
            if (packet === null)
              return yield* new SongContributionFailure({ code: "policy_unavailable" });
            const context = yield* decodeRow(C.ContextResponseV2, packet);
            return runtime.rewardsEnabled
              ? context
              : {
                  object: "song_megapot_funding_context" as const,
                  version: 2 as const,
                  readiness: "unavailable" as const,
                  target: context.target,
                  persona_id: personaId,
                  reason: "paused" as const,
                  retry_after_seconds: null,
                  own_recovery_href: null,
                };
          }),
        ),
      ),
    current: (scope, accountId) =>
      read(
        "song-contribution.current.read",
        "SELECT read_owned_song_contribution_current_v2($1::jsonb) AS packet",
        [json({ ...scope, accountId })],
      ),
    command: (scope, accountId, operation, key) =>
      read(
        "song-contribution.receipt.read",
        "SELECT read_song_contribution_command_v2($1::jsonb,$2,$3) AS packet",
        [json({ ...scope, accountId }), operation, key],
      ),
  };
}

const packetSchema = Schema.Struct({
  snapshot: Schema.Struct({
    snapshot_id: C.IdV2,
    slot_id: C.IdV2,
    profile_id: C.IdV2,
    witness_id: C.IdV2,
    context_hash: C.HashV2,
    context: C.ContextReadyV2,
    budget: budgetSchema,
    costs_reconciled: Schema.Boolean,
    refusal: Schema.NullOr(C.ErrorV2.fields.code),
    recovery_authority: recoverySchema,
    created_at: Schema.String,
  }),
  slot: Schema.Struct({
    slot_id: C.IdV2,
    community_id: C.IdV2,
    post_id: C.IdV2,
    generation: natural,
    target: Schema.NullOr(C.CommittedTargetV2),
    terms: Schema.NullOr(C.TermsV2),
    status: Schema.Literals(["open", "closing", "sealed", "incident"]),
    reward_policy_ready: Schema.Boolean,
    admission_closed_at: Schema.NullOr(Schema.String),
  }),
  profile: Schema.Struct({
    profile_id: C.IdV2,
    profile_hash: C.HashV2,
    accepted: Schema.Boolean,
    valid_until: Schema.String,
    policy: limits,
    capacity_profile: capacityProfile,
    nonce_policy: Schema.Struct({ hash: C.HashV2, maxAgeMs: positive }),
    recovery_policy: Schema.NullOr(C.CancellationRecoveryPolicyV2),
    created_at: Schema.String,
  }),
  witness: Schema.Struct({
    witness_id: C.IdV2,
    profile_id: C.IdV2,
    witness_hash: C.HashV2,
    schedule,
    nonce_witness: witnessSchema,
    valid_until: Schema.String,
    created_at: Schema.String,
  }),
  principal: Schema.Struct({ funded: Schema.BigIntFromString, reserved: Schema.BigIntFromString }),
  counts: Schema.Struct({
    activeAccount: natural,
    activeAccountLeg: natural,
    legLiabilities: natural,
    admittedLeg: natural,
    admittedAccountLeg: natural,
  }),
  work: Schema.NullOr(
    Schema.Struct({
      account: Schema.optional(natural),
      leg: Schema.optional(natural),
      global: Schema.optional(natural),
    }),
  ),
});

/** A trusted observer supplies verified evidence from the existing canonical RPC
 * reader. This persists incoming truth only; no refund/signing/role operation. */
const principalEvidenceSchema = Schema.Struct({
  receiptId: C.IdV2,
  contributionId: C.IdV2,
  category: Schema.Literals(["pool_principal", "late_principal"]),
  evidence: Schema.Struct({ ...C.ReceiptEvidenceV2.fields, finalized_at: C.InstantV2 }),
  senderAddress: C.AddressV2,
  recipientAddress: C.AddressV2,
  tokenAddress: C.AddressV2,
  instructionHash: C.HashV2,
  attestationHash: C.HashV2,
  policyHash: C.HashV2,
  checkpointBlock: C.UIntV2,
  checkpointHash: C.TxHashV2,
  observedConfirmedNonce: C.UIntV2,
  exactInstruction: Schema.Boolean,
});
export const persistRewardFundingPrincipalIn = Effect.fn(
  "SongContributionRepository.persistPrincipalIn",
)(function* (db: ControlPlaneTransaction, proof: FundingPrincipalEvidence) {
  const validated = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(principalEvidenceSchema, { onExcessProperty: "error" })(proof),
    catch: () => new SongContributionFailure({ code: "receipt_mismatch" }),
  });
  return yield* db.execute({
    label: "song-contribution.principal.accept",
    text: "SELECT accept_reward_funding_principal_v2($1::jsonb) AS packet",
    values: [json(validated)],
    readonly: false,
  });
});

/** Both queue observers and reconciliation use the same fenced principal write. */
const acceptSongFundingPrincipal = Effect.fn("SongFundingWork.accept")(function* (
  work: SongFundingWork,
  proof: FundingPrincipalEvidence,
) {
  return yield* withSongMegapotContributionTransaction(
    work.identity,
    Effect.fn("SongFundingWork.acceptIn")(function* (tx: ControlPlaneTransaction) {
      yield* tx.execute({
        label: "song-funding.work.fence",
        text: "SELECT require_song_funding_work_lease_v2($1,$2)",
        values: [work.workId, work.token],
        readonly: false,
      });
      return yield* persistRewardFundingPrincipalIn(tx, proof);
    }),
  );
});

/** The queued observer reuses the actual canonical incoming reader and the SAME
 * transaction boundary. Provider work is outside the write transaction. Caller
 * identity comes from owned durable work, not a browser's claimed sender. No
 * outgoing interpreter, scanner absence proof or no-principal closure is invented.
 */
export function makeControlPlaneRewardFundingObserver(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  discover: ReturnType<typeof makeRewardFundingReceiptDiscovery>,
) {
  return Effect.fn("SongContributionRepository.observePrincipal")(function* (
    work: SongFundingWork,
    transactionHash: string,
  ) {
    const identity = work.identity;
    return yield* mapStorage(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const loaded = yield* db.execute<{ packet: unknown }>({
          label: "song-contribution.observer.original",
          text: "SELECT load_owned_song_contribution_v2($1::jsonb) AS packet",
          values: [json(identity)],
          readonly: true,
        });
        if (loaded.rows.length !== 1 || loaded.rows[0]?.packet === null)
          return yield* new SongContributionFailure({ code: "not_found" });
        const state = yield* decodeRow(stateSchema, loaded.rows[0]?.packet);
        const proof = yield* discover(state, transactionHash);
        if (proof === null) return null;
        return yield* acceptSongFundingPrincipal(work, proof);
      }).pipe(Effect.provide(layer)),
    );
  });
}

export type SongFundingWork = Readonly<{
  workId: string;
  token: string;
  identity: CommandIdentity;
  state: ContributionState;
  source: FundingRecoverySource;
  workPolicy: SongFundingRecoveryWorkPolicy;
  hint: { readonly instructionHash: string; readonly transactionHash: string } | null;
  nextBlock: string | null;
}>;
const workPacketSchema = Schema.Struct({
  workId: C.IdV2,
  token: C.IdV2,
  identity: CommandIdentity,
  state: stateSchema,
  payload: Schema.Struct({
    hint: Schema.NullOr(Schema.Struct({ instructionHash: C.HashV2, transactionHash: C.TxHashV2 })),
    attempts: positive,
    status: Schema.Literal("running"),
    leaseToken: C.IdV2,
    leaseUntil: C.InstantV2,
    result: Schema.optional(
      Schema.Struct({
        complete: Schema.Boolean,
        nextBlock: Schema.NullOr(C.UIntV2),
        error: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  profileId: C.IdV2,
  profileHash: C.HashV2,
  validUntil: C.InstantV2,
  policy: Schema.NullOr(C.CancellationRecoveryPolicyV2),
  noncePolicy: Schema.Struct({ hash: C.HashV2, maxAgeMs: positive }),
  workPolicy: recoveryWorkPolicySchema,
  deployment: Schema.Unknown,
  attestationBlock: C.UIntV2,
  attestationBlockHash: C.TxHashV2,
});

/** Real finite work/canonical-principal repository. No provider is called here;
 * callback, unknown-commit and original shared-wallet authority are unchanged. */
export function makeControlPlaneSongFundingRecoveryStore(
  layer: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
) {
  const provided = <A, E>(effect: Effect.Effect<A, E | ControlPlaneError, ControlPlaneDb>) =>
    mapStorage(effect.pipe(Effect.provide(layer)));
  const finish = (
    work: SongFundingWork,
    result: { complete: boolean; nextBlock: string | null; error: string | null },
  ) =>
    provided(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        yield* db.withTransaction((tx) =>
          tx.execute({
            label: "song-funding.work.finish",
            text: "SELECT finish_song_funding_work_v2($1,$2,$3::jsonb)",
            values: [work.workId, work.token, json(result)],
            readonly: false,
          }),
        );
      }),
    );
  return {
    list: (limit: number) =>
      provided(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const r = yield* db.execute<{ id: unknown }>({
            label: "song-funding.work.list",
            text: "SELECT list_song_funding_work_v2($1) AS id",
            values: [limit],
            readonly: true,
          });
          return yield* Effect.forEach(r.rows, (row) => decodeRow(C.IdV2, row.id));
        }),
      ),
    claim: (id: string, token: string) =>
      provided(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          const r = yield* db.withTransaction((tx) =>
            tx.execute<{ packet: unknown }>({
              label: "song-funding.work.claim",
              text: "SELECT claim_song_funding_work_v2($1,$2) AS packet",
              values: [id, token],
              readonly: false,
            }),
          );
          if (r.rows[0]?.packet === null) return null;
          const p = yield* decodeRow(workPacketSchema, r.rows[0]?.packet);
          const deployment = yield* Effect.try({
            try: () =>
              validateMegapotV2DeploymentAttestation(
                p.deployment as Parameters<typeof validateMegapotV2DeploymentAttestation>[0],
              ),
            catch: () => new SongContributionFailure({ code: "attestation_unavailable" }),
          });
          return {
            workId: p.workId,
            token: p.token,
            identity: p.identity,
            state: p.state,
            source: {
              profileId: p.profileId,
              profileHash: p.profileHash,
              validUntil: p.validUntil,
              policy: p.policy,
              noncePolicy: p.noncePolicy,
              deployment,
              attestationBlock: p.attestationBlock,
              attestationBlockHash: p.attestationBlockHash,
            },
            workPolicy: p.workPolicy,
            hint: p.payload.hint,
            nextBlock: p.payload.result?.nextBlock ?? null,
          } satisfies SongFundingWork;
        }),
      ),
    record: (work: SongFundingWork, evidence: FundingRecoveryEvidence) =>
      provided(
        Effect.gen(function* () {
          const e = yield* decodeRow(FundingRecoveryEvidence, evidence);
          if ((yield* digestFundingPreimageV2(recoveryEvidencePreimage(e))) !== e.witnessHash)
            return yield* new SongContributionFailure({
              code: "cancellation_recovery_unavailable",
            });
          yield* withSongMegapotContributionTransaction(work.identity, (tx) =>
            tx.execute({
              label: "song-funding.recovery.record",
              text: "SELECT record_song_recovery_evidence_v2($1,$2,$3::jsonb)",
              values: [work.workId, work.token, json(e)],
              readonly: false,
            }),
          );
        }),
      ),
    invalidate: (work: SongFundingWork, reason: SongContributionFailure["code"]) =>
      provided(
        withSongMegapotContributionTransaction(work.identity, (tx) =>
          tx.execute({
            label: "song-funding.recovery.invalidate",
            text: "SELECT invalidate_song_recovery_evidence_v2($1,$2,$3)",
            values: [work.workId, work.token, reason],
            readonly: false,
          }),
        ).pipe(Effect.asVoid),
      ),
    accept: (work: SongFundingWork, proof: FundingPrincipalEvidence) =>
      provided(acceptSongFundingPrincipal(work, proof)),
    finish,
  };
}
