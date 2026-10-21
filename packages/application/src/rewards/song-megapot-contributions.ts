import { Effect, Schema } from "effect";
import {
  type CancellationReceiptV2,
  type CancellationRecoveryPolicyV2,
  CommittedTargetV2 as CommittedTargetSchema,
  type CommittedTargetV2,
  ContextReadyV2 as ContextReadySchema,
  type ContextReadyV2,
  ContextRequestV2,
  ContextResponseV2,
  ErrorV2 as ContributionErrorSchema,
  type ContributionReceiptV2,
  type ContributionRequestV2,
  CurrentStateV2,
  cancellationInstructionPreimageV2,
  cancellationPolicyPreimageV2,
  committedTermsPreimageV2,
  decodeFundingCommandV2,
  type ErrorV2,
  FundingCommandReceiptV2,
  type FundingCommandV2,
  type FundingOperationV2,
  fundingCommandPreimageV2,
  fundingHashPreimageV2,
  HashV2,
  IdV2,
  InstantV2,
  KeyV2,
  type ObservationReceiptV2,
  type OwnedActorV2,
  projectCommittedTarget,
  projectContextReference,
  projectOwnedActor,
  projectQualificationBinding,
  projectQualificationTemplate,
  projectSongTarget,
  projectTarget,
  projectTerms,
  prospectiveTermsPreimageV2,
  CancellationRecoveryPolicyV2 as RecoveryPolicySchema,
  type RecoveryReceiptV2,
  type SubmissionClaimDeliveryV2,
  type SubmissionClaimReceiptV2,
  TermsV2 as TermsSchema,
  type TermsV2,
} from "../../../contracts/src/rewards-song-contributions-v2.ts";
import {
  type AuthoritativeSchedule,
  type CapacityProfile,
  type PoolPrincipalBudget,
  songMegapotCapacity,
} from "../../../domain/src/song-megapot-capacity.ts";

export class SongContributionFailure extends Schema.TaggedError<SongContributionFailure>()(
  "SongContributionFailure",
  { code: ContributionErrorSchema.fields.code, underlying: Schema.optional(Schema.Defect()) },
) {}
type Code = ErrorV2["code"];
const fail = (code: Code) => Effect.fail(new SongContributionFailure({ code }));
const parse = <A>(f: () => A) =>
  Effect.try({ try: f, catch: () => new SongContributionFailure({ code: "invalid_request" }) });
export const digestFundingPreimageV2 = (preimage: string) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    },
    catch: () => new SongContributionFailure({ code: "outcome_unknown" }),
  });

export type FundingScope = Readonly<{
  communityId: string;
  postId: string;
  contributionId: string | null;
}>;
export type FundingCommandIdentity = FundingScope &
  Readonly<{ accountId: string; operation: FundingOperationV2; key: string; hash: string }>;
type Identity = FundingCommandIdentity;
export type FundingCommandReceipt =
  | ContributionReceiptV2
  | SubmissionClaimReceiptV2
  | CancellationReceiptV2
  | ObservationReceiptV2
  | RecoveryReceiptV2;
type CommandReceipt = FundingCommandReceipt;
export type StoredFundingCommand = Readonly<{ requestHash: string; receipt: CommandReceipt }>;

export type ContributionState = Readonly<{
  owner: OwnedActorV2;
  receipt: ContributionReceiptV2;
  anchorBlockHash: string;
  revision: number;
  fundingState:
    | "instruction_issued"
    | "submission_claimed"
    | "broadcast_unknown"
    | "confirming"
    | "expired_reconciling"
    | "pool_credited"
    | "late_principal_owed"
    | "nonce_closed_no_principal";
  effectiveDeadline: string;
  nonceFinalized: boolean;
  fundingGrant: SubmissionClaimReceiptV2 | null;
  cancellationGrant: SubmissionClaimReceiptV2 | null;
  cancellationHead: CancellationReceiptV2 | null;
  preparationsUsed: number;
}>;

/** Required selected inputs. No candidate numerical or monetary defaults. */
export type FundingLimitsPolicy = Readonly<{
  maxActiveAccount: number;
  maxActiveAccountLeg: number;
  maxLegLiabilities: number;
  maxAdmittedLeg: number;
  maxAdmittedAccountLeg: number;
  workPerInstruction: number;
  economicsPolicyHash: string;
  gasPolicyHash: string;
  custodyPolicyHash: string;
}>;
export type FundingCounters = Readonly<{
  activeAccount: number;
  activeAccountLeg: number;
  legLiabilities: number;
  admittedLeg: number;
  admittedAccountLeg: number;
  accountWorkRemaining: number;
  legWorkRemaining: number;
  globalWorkRemaining: number;
  refundEnvelopeReady: boolean;
  unresolvedV1Wallet: boolean;
}>;

export type FundingAdmission = Readonly<{
  /** Authoritative reconstruction of requested immutable facts, never supplied by the browser. */
  context: ContextReadyV2;
  actor: OwnedActorV2;
  currentTarget: CommittedTargetV2 | null;
  currentTerms: TermsV2 | null;
  currentSlotGeneration: number;
  /** Only this origin generation may bind a concurrent first creation. */
  originEmptyGeneration: number | null;
  capacityProfile: CapacityProfile | null;
  schedule: AuthoritativeSchedule | null;
  budget: PoolPrincipalBudget;
  costsReconciled: boolean;
  policy: FundingLimitsPolicy | null;
  counters: FundingCounters;
  refusal: Code | null;
  confirmedNonce: string;
  pendingNonce: string;
  nonceWitnessFresh: boolean;
  sharedNonceLeaseAvailable: boolean;
}>;

export type RecoveryAuthority = Readonly<{
  /** Null unless the port verified CURRENT accepted/unrevoked recovery evidence
   * and fresh nonce evidence under the original fences. An immutable snapshot,
   * future expiry or permanent nonce lease alone cannot supply this authority. */
  policy: CancellationRecoveryPolicyV2 | null;
  attestationId: string;
  attestationHash: string;
  attestationValidUntil: string;
  originalWalletStillOwned: boolean;
  currentSigningRefusal: Code | null;
  boundedWorkAvailable: boolean;
}>;

/** Selected bounded observer work, independent of funding/cancellation validity.
 * Absent policy is unavailable, never an operational default. */
export type SongFundingRecoveryWorkPolicy = Readonly<{
  maxAttempts: number;
  leaseMs: number;
  maximumBlocks: number;
  maximumLogs: number;
  receipt: Readonly<{
    policyHash: string;
    requiredConfirmations: number;
    maximumClockSkewMs: number;
    maximumObservationAgeMs: number;
  }>;
}>;

/** Implementations MUST use the shared nonce allocator/receipt/obligation authorities.
 * No provider I/O inside transaction. The concrete CP3 adapter persists these
 * operations on the accepted ControlPlaneDb/shared-nonce boundary.
 */
export interface SongContributionTransaction {
  readonly lookup: () => Effect.Effect<StoredFundingCommand | null, SongContributionFailure>;
  /** Locks account -> song/leg -> shared sender lease -> policy/work; revalidates preflight. */
  readonly fundingAdmission: (
    request: ContributionRequestV2,
  ) => Effect.Effect<FundingAdmission, SongContributionFailure>;
  readonly now: () => Effect.Effect<string, SongContributionFailure>;
  readonly id: (kind: string) => Effect.Effect<string, SongContributionFailure>;
  readonly instantiateRewardPolicy: (
    offerId: string,
    templateHash: string,
  ) => Effect.Effect<string, SongContributionFailure>;
  /** Private read. Claims must reread after recoveryAuthority acquires its fences. */
  readonly ownedContribution: () => Effect.Effect<ContributionState, SongContributionFailure>;
  /** Holds the existing account -> slot -> original shared nonce fences until commit. */
  readonly recoveryAuthority: (
    state: ContributionState,
  ) => Effect.Effect<RecoveryAuthority, SongContributionFailure>;
  /** Atomic insert + shared nonce lease + capacity/counters/work/gas envelope + song slot.
   * A failed/unknown commit is never interpreted as no allocation. */
  readonly create: (
    state: ContributionState,
    admission: FundingAdmission,
  ) => Effect.Effect<void, SongContributionFailure>;
  /** Atomic revision CAS + append-only command receipt/plan/purpose unique row. */
  readonly update: (
    before: ContributionState,
    after: ContributionState,
    command: StoredFundingCommand,
  ) => Effect.Effect<void, SongContributionFailure>;
  /** Validate hints against the original or any retained own cancellation plan.
   * A locator/queued recovery is never evidence of payment or no-send. */
  readonly recordReconciliationRequest: (
    state: ContributionState,
    command: StoredFundingCommand,
    hint: Readonly<{ instructionHash: string; transactionHash: string }> | null,
  ) => Effect.Effect<void, SongContributionFailure>;
}
export interface SongContributionPorts {
  /** Exact session + original-account privacy + bounded reads + Origin/CSRF on writes.
   * New-funding exclusion is NOT a reason to deny own-liability replay. */
  readonly authorize: (
    scope: FundingScope,
  ) => Effect.Effect<{ readonly accountId: string }, SongContributionFailure>;
  readonly lookup: (
    identity: Identity,
  ) => Effect.Effect<StoredFundingCommand | null, SongContributionFailure>;
  /** Bounded witness reads only, no allocation. Unavailable facts are retained for a
   * locked true miss; same-key replay must not require fresh business evidence. */
  readonly preflight: (
    identity: Identity,
    request: FundingCommandV2<FundingOperationV2>,
  ) => Effect.Effect<void, SongContributionFailure>;
  /** Idempotency key is locked FIRST. Unknown commit/read => outcome_unknown, never retry with a new key.
   * The callback must not be rerun automatically after an ambiguous commit. */
  readonly transaction: <A>(
    identity: Identity,
    run: (tx: SongContributionTransaction) => Effect.Effect<A, SongContributionFailure>,
  ) => Effect.Effect<A, SongContributionFailure>;
}

/** Effect-free private queries: no slot/quote/nonce allocation, claim, observer
 * enqueue or transaction callback is available through this capability.
 * Unknown reads are failures, never an absent receipt or unpaid instruction.
 */
export interface SongContributionReadPorts {
  readonly authorize: SongContributionPorts["authorize"];
  readonly context: (
    scope: FundingScope,
    accountId: string,
    personaId: string,
  ) => Effect.Effect<unknown, SongContributionFailure>;
  readonly current: (
    scope: FundingScope,
    accountId: string,
  ) => Effect.Effect<unknown | null, SongContributionFailure>;
  readonly command: (
    scope: FundingScope,
    accountId: string,
    operation: FundingOperationV2,
    key: string,
  ) => Effect.Effect<unknown | null, SongContributionFailure>;
}

const privateStateRead = Schema.Struct({ accountId: IdV2, current: CurrentStateV2 });
const privateCommandRead = Schema.Struct({
  accountId: IdV2,
  communityId: IdV2,
  postId: IdV2,
  operation: Schema.Literals([
    "CreateSongMegapotContributionV2",
    "ClaimSongMegapotContributionSubmissionV2",
    "ObserveSongMegapotContributionV2",
    "RecoverSongMegapotContributionV2",
    "PrepareSongMegapotContributionCancellationV2",
  ]),
  key: KeyV2,
  requestHash: HashV2,
  receipt: FundingCommandReceiptV2,
});
const decodeRead = <A>(f: () => A) =>
  Effect.try({ try: f, catch: () => new SongContributionFailure({ code: "outcome_unknown" }) });

export function makeSongMegapotContributionReads(ports: SongContributionReadPorts) {
  const context = Effect.fn("SongMegapotContribution.readContext")(function* (
    scope: FundingScope,
    rawQuery: unknown,
  ) {
    const actor = yield* ports.authorize(scope);
    const query = yield* parse(() =>
      Schema.decodeUnknownSync(ContextRequestV2, { onExcessProperty: "error" })(rawQuery),
    );
    if (scope.contributionId !== null) return yield* fail("invalid_request");
    const value = yield* ports.context(scope, actor.accountId, query.persona_id);
    const result = yield* decodeRead(() =>
      Schema.decodeUnknownSync(ContextResponseV2, { onExcessProperty: "error" })(value),
    );
    if (
      result.target.community_id !== scope.communityId ||
      result.target.post_id !== scope.postId ||
      (result.readiness === "ready"
        ? result.actor.account_id !== actor.accountId ||
          result.actor.persona_id !== query.persona_id
        : result.persona_id !== query.persona_id)
    )
      return yield* fail("not_found");
    if (result.readiness === "ready") {
      if ((yield* digestFundingPreimageV2(contextPreimage(result))) !== result.context_hash)
        return yield* fail("outcome_unknown");
      if (result.quote.kind === "prospective") {
        if (
          result.target.kind !== "empty" ||
          JSON.stringify(projectSongTarget(result.quote.prospective_terms.target)) !==
            JSON.stringify(projectSongTarget(result.target)) ||
          (yield* digestFundingPreimageV2(
            prospectiveTermsPreimageV2(result.quote.prospective_terms),
          )) !== result.quote.prospective_terms_hash
        )
          return yield* fail("outcome_unknown");
      } else if (
        result.target.kind !== "committed" ||
        result.quote.committed_terms_hash !== result.quote.committed_terms.terms_hash ||
        !(yield* consistentCommittedTerms(result.quote.committed_terms, result.target))
      )
        return yield* fail("outcome_unknown");
    }
    return result;
  });
  const current = Effect.fn("SongMegapotContribution.readCurrent")(function* (scope: FundingScope) {
    const actor = yield* ports.authorize(scope);
    if (scope.contributionId === null) return yield* fail("invalid_request");
    const value = yield* ports.current(scope, actor.accountId);
    if (value === null) return yield* fail("not_found");
    const row = yield* decodeRead(() =>
      Schema.decodeUnknownSync(privateStateRead, { onExcessProperty: "error" })(value),
    );
    const result = row.current;
    if (
      row.accountId !== actor.accountId ||
      result.contribution_id !== scope.contributionId ||
      result.target.community_id !== scope.communityId ||
      result.target.post_id !== scope.postId
    )
      return yield* fail("not_found");
    if (
      result.command_receipt.contribution_id !== result.contribution_id ||
      result.command_receipt.funding_effect_id !== result.funding_effect_id ||
      result.command_receipt.terms_hash !== result.terms_hash ||
      result.command_receipt.instruction.instruction_hash !== result.instruction_hash ||
      result.command_receipt.instruction.from !== result.original_sender ||
      JSON.stringify(projectCommittedTarget(result.command_receipt.target)) !==
        JSON.stringify(projectCommittedTarget(result.target))
    )
      return yield* fail("outcome_unknown");
    const cancellation = result.cancellation.current_receipt;
    if (
      result.command_receipt.committed_terms.terms_hash !== result.terms_hash ||
      !(yield* consistentCommittedTerms(result.command_receipt.committed_terms, result.target))
    )
      return yield* fail("outcome_unknown");
    if (
      cancellation !== null &&
      (cancellation.contribution_id !== result.contribution_id ||
        cancellation.original_funding_instruction_hash !== result.instruction_hash ||
        cancellation.sender !== result.original_sender ||
        cancellation.nonce !== result.command_receipt.instruction.nonce ||
        cancellation.wallet_assignment_id !==
          result.command_receipt.instruction.wallet_assignment_id)
    )
      return yield* fail("outcome_unknown");
    return result;
  });
  const command = Effect.fn("SongMegapotContribution.readCommand")(function* (
    scope: FundingScope,
    operation: FundingOperationV2,
    key: string,
  ) {
    const actor = yield* ports.authorize(scope);
    const value = yield* ports.command(scope, actor.accountId, operation, key);
    if (value === null) return yield* fail("not_found");
    const row = yield* decodeRead(() =>
      Schema.decodeUnknownSync(privateCommandRead, { onExcessProperty: "error" })(value),
    );
    if (
      row.accountId !== actor.accountId ||
      row.communityId !== scope.communityId ||
      row.postId !== scope.postId ||
      row.operation !== operation ||
      row.key !== key
    )
      return yield* fail("not_found");
    if (row.requestHash !== row.receipt.request_hash) return yield* fail("outcome_unknown");
    const objects: Record<FundingOperationV2, FundingCommandReceipt["object"]> = {
      CreateSongMegapotContributionV2: "song_megapot_contribution_command_receipt",
      ClaimSongMegapotContributionSubmissionV2: "contribution_submission_claim_receipt",
      ObserveSongMegapotContributionV2: "contribution_observation_command_receipt",
      RecoverSongMegapotContributionV2: "contribution_recovery_command_receipt",
      PrepareSongMegapotContributionCancellationV2: "contribution_cancellation_command_receipt",
    };
    if (row.receipt.object !== objects[operation]) return yield* fail("outcome_unknown");
    // An immutable claim receipt is deliberately returned without a fresh_grant
    // delivery envelope. Historical GET/replay cannot authorize another send.
    return row.receipt;
  });
  return { context, current, command };
}

function href(scope: FundingScope, contributionId: string): string {
  return `/communities/${encodeURIComponent(scope.communityId)}/posts/${encodeURIComponent(scope.postId)}/megapot-contributions/${encodeURIComponent(contributionId)}`;
}

const contextPreimage = (c: ContextReadyV2) => {
  const l = c.limits;
  const limits = [
    "profile_id",
    "minimum_atomic",
    "maximum_atomic",
    "usable_capacity_atomic",
    "capacity_revision",
    "max_admitted_effects_per_leg",
    "fee_policy_id",
    "reservation_ttl_seconds",
    "latest_allocation_at",
    "reservation_deadline_upper_bound",
  ] as const;
  return fundingHashPreimageV2("pirate.song-megapot-funding-context.v2", [
    projectContextReference(c.context_ref),
    projectTarget(c.target),
    projectOwnedActor(c.actor),
    c.chain_id,
    c.token_address,
    c.custody_address,
    c.attestation_id,
    c.quote.kind,
    c.quote.kind === "prospective" ? c.quote.prospective_terms_hash : c.quote.committed_terms_hash,
    limits.map((k) => [k, l[k]]),
    c.context_expires_at,
  ]);
};

function limitsValid(p: FundingLimitsPolicy): boolean {
  return (
    [
      p.maxActiveAccount,
      p.maxActiveAccountLeg,
      p.maxLegLiabilities,
      p.maxAdmittedLeg,
      p.maxAdmittedAccountLeg,
      p.workPerInstruction,
    ].every((n) => Number.isSafeInteger(n) && n > 0) &&
    [p.economicsPolicyHash, p.gasPolicyHash, p.custodyPolicyHash].every((v) =>
      /^[a-f0-9]{64}$/u.test(v),
    )
  );
}

function compatibleOrigin(
  terms: TermsV2,
  target: CommittedTargetV2,
  context: ContextReadyV2,
): boolean {
  if (context.quote.kind !== "prospective") return false;
  const p = context.quote.prospective_terms;
  const sort = <T extends { readonly activity: string }>(items: readonly T[]) =>
    [...items].sort(
      (a, b) =>
        ["study", "karaoke", "dance"].indexOf(a.activity) -
        ["study", "karaoke", "dance"].indexOf(b.activity),
    );
  // Compare templates without allocated IDs; bindings have their own acyclic commitment.
  const templates = sort(terms.qualification_bindings).map(
    ({ binding_id: _b, objective_id: _o, offer_id: _f, leg_id: _l, ...t }) =>
      projectQualificationTemplate(t),
  );
  return (
    target.community_id === p.target.community_id &&
    target.post_id === p.target.post_id &&
    target.canonical_song_id === p.target.canonical_song_id &&
    target.audio_revision === p.target.audio_revision &&
    terms.ends_at === p.fixed_ends_at &&
    terms.profile_id === p.profile_id &&
    terms.profile_hash === p.profile_hash &&
    terms.funding_policy_revision === p.funding_policy_revision &&
    terms.funding_policy_hash === p.funding_policy_hash &&
    terms.first_drawing_id === p.first_drawing_id &&
    terms.last_planned_drawing_id === p.last_planned_drawing_id &&
    terms.planned_schedule_hash === p.planned_schedule_hash &&
    terms.disclosure_version === p.disclosure_version &&
    terms.ticket_price_ceiling_atomic === p.ticket_price_ceiling_atomic &&
    JSON.stringify(terms.planned_drawing_ids) === JSON.stringify(p.planned_drawing_ids) &&
    JSON.stringify(templates) ===
      JSON.stringify(sort(p.qualification_templates).map(projectQualificationTemplate))
  );
}

const consistentCommittedTerms = Effect.fn("SongMegapotContribution.consistentCommittedTerms")(
  function* (terms: TermsV2, target: CommittedTargetV2) {
    if (
      terms.qualification_bindings.some(
        (b) => b.offer_id !== target.offer_id || b.leg_id !== target.pool_leg_id,
      )
    )
      return false;
    const ordered = [...terms.qualification_bindings].sort(
      (a, b) =>
        ["study", "karaoke", "dance"].indexOf(a.activity) -
        ["study", "karaoke", "dance"].indexOf(b.activity),
    );
    // Terms commits the full binding payload through this separate acyclic hash.
    const bindingHash = yield* digestFundingPreimageV2(
      fundingHashPreimageV2(
        "pirate.shared-song-qualification-bindings.v1",
        ordered.map(projectQualificationBinding),
      ),
    );
    return (
      bindingHash === terms.qualification_bindings_hash &&
      (yield* digestFundingPreimageV2(committedTermsPreimageV2(terms))) === terms.terms_hash
    );
  },
);

const createContribution = Effect.fn("SongMegapotContribution.create")(function* (
  tx: SongContributionTransaction,
  identity: Identity,
  request: ContributionRequestV2,
) {
  const a = yield* tx.fundingAdmission(request);
  if (a.refusal !== null) return yield* fail(a.refusal);
  if (a.policy === null || !limitsValid(a.policy)) return yield* fail("policy_unavailable");
  const p = a.policy;
  const c = yield* parse(() =>
    Schema.decodeUnknownSync(ContextReadySchema, { onExcessProperty: "error" })(a.context),
  );
  const rawNow = yield* tx.now();
  const now = yield* parse(() => Schema.decodeUnknownSync(InstantV2)(rawNow));
  const amount = BigInt(request.funding_amount_atomic);
  if (a.actor.account_id !== identity.accountId || a.actor.persona_id !== request.persona_id)
    return yield* fail("persona_not_owned");
  if (a.actor.community_id !== identity.communityId) return yield* fail("persona_wrong_community");
  if (JSON.stringify(projectOwnedActor(a.actor)) !== JSON.stringify(projectOwnedActor(c.actor)))
    return yield* fail("wallet_not_ready");
  if (
    c.target.community_id !== identity.communityId ||
    c.target.post_id !== identity.postId ||
    JSON.stringify(projectContextReference(request.context_ref)) !==
      JSON.stringify(projectContextReference(c.context_ref)) ||
    request.expected_lifecycle_revision !== c.lifecycle_revision ||
    request.context_ref.lifecycle_revision !== c.lifecycle_revision ||
    c.context_ref.wallet_assignment_id !== a.actor.wallet_assignment_id ||
    c.context_ref.profile_id !== c.limits.profile_id ||
    c.context_ref.schedule_witness_id !== c.schedule.schedule_witness_id
  )
    return yield* fail("quote_reference_invalid");
  if (
    request.expected_context_hash !== c.context_hash ||
    (yield* digestFundingPreimageV2(contextPreimage(c))) !== c.context_hash
  )
    return yield* fail("quote_mismatch");
  if (now >= c.context_expires_at || now >= c.limits.latest_allocation_at)
    return yield* fail("quote_expired");
  const quotedTerms =
    c.quote.kind === "prospective" ? c.quote.prospective_terms : c.quote.committed_terms;
  if (
    quotedTerms.profile_id !== c.context_ref.profile_id ||
    quotedTerms.profile_hash !== c.context_ref.profile_hash ||
    quotedTerms.funding_policy_hash !== c.context_ref.funding_policy_hash ||
    (c.target.kind === "empty" &&
      (c.target.slot_id !== c.context_ref.slot_id ||
        c.target.slot_generation !== c.context_ref.slot_generation))
  )
    return yield* fail("invalid_request");
  if (c.quote.kind === "prospective") {
    if (
      c.target.kind !== "empty" ||
      JSON.stringify(projectSongTarget(c.quote.prospective_terms.target)) !==
        JSON.stringify(projectSongTarget(c.target))
    )
      return yield* fail("invalid_request");
    if (
      request.expected_terms.kind !== "prospective" ||
      request.expected_terms.prospective_terms_hash !== c.quote.prospective_terms_hash ||
      (yield* digestFundingPreimageV2(prospectiveTermsPreimageV2(c.quote.prospective_terms))) !==
        c.quote.prospective_terms_hash
    )
      return yield* fail("terms_mismatch");
  } else if (
    request.expected_terms.kind !== "committed" ||
    request.expected_terms.terms_hash !== c.quote.committed_terms_hash
  )
    return yield* fail("terms_mismatch");
  if (
    c.quote.kind === "committed" &&
    (c.target.kind !== "committed" ||
      c.quote.committed_terms.terms_hash !== c.quote.committed_terms_hash ||
      !(yield* consistentCommittedTerms(c.quote.committed_terms, c.target)))
  )
    return yield* fail("invalid_request");

  // Validate the locked target and entire quoted/current payload BEFORE using any
  // quote end/IDs for capacity or allocating target, contribution or nonce identities.
  let target = a.currentTarget;
  let terms = a.currentTerms;
  if ((target === null) !== (terms === null)) return yield* fail("recovery_required");
  if (target !== null && terms !== null) {
    target = yield* parse(() =>
      Schema.decodeUnknownSync(CommittedTargetSchema, { onExcessProperty: "error" })(target),
    );
    terms = yield* parse(() =>
      Schema.decodeUnknownSync(TermsSchema, { onExcessProperty: "error" })(terms),
    );
    if (!(yield* consistentCommittedTerms(terms, target))) return yield* fail("terms_mismatch");
    if (c.quote.kind === "prospective") {
      if (
        c.target.kind !== "empty" ||
        a.originEmptyGeneration !== c.target.slot_generation ||
        a.currentSlotGeneration !== c.target.slot_generation + 1 ||
        terms.origin_slot_generation !== c.target.slot_generation ||
        terms.origin_prospective_terms_hash !== c.quote.prospective_terms_hash ||
        !compatibleOrigin(terms, target, c)
      )
        return yield* fail("context_stale");
    } else if (
      terms.terms_hash !== c.quote.committed_terms_hash ||
      c.target.kind !== "committed" ||
      a.currentSlotGeneration !== c.context_ref.slot_generation ||
      JSON.stringify(projectCommittedTarget(target)) !==
        JSON.stringify(projectCommittedTarget(c.target)) ||
      JSON.stringify(projectTerms(terms)) !== JSON.stringify(projectTerms(c.quote.committed_terms))
    )
      return yield* fail("terms_mismatch");
  } else if (
    c.quote.kind !== "prospective" ||
    c.target.kind !== "empty" ||
    a.currentSlotGeneration !== c.target.slot_generation
  )
    return yield* fail("context_stale");
  const counters = a.counters;
  if (
    Object.values(counters).some(
      (v) => typeof v === "number" && (!Number.isSafeInteger(v) || v < 0),
    )
  )
    return yield* fail("recovery_required");
  if (
    counters.unresolvedV1Wallet ||
    !a.sharedNonceLeaseAvailable ||
    !a.nonceWitnessFresh ||
    a.confirmedNonce !== a.pendingNonce
  )
    return yield* fail("wallet_nonce_busy");
  if (counters.admittedLeg > counters.legLiabilities) return yield* fail("recovery_required");
  if (
    counters.activeAccount >= p.maxActiveAccount ||
    counters.activeAccountLeg >= p.maxActiveAccountLeg ||
    counters.legLiabilities >= p.maxLegLiabilities ||
    counters.legLiabilities >= p.maxAdmittedLeg ||
    counters.admittedAccountLeg + counters.activeAccountLeg >= p.maxAdmittedAccountLeg
  )
    return yield* fail("effect_limit");
  if (
    Math.min(
      counters.accountWorkRemaining,
      counters.legWorkRemaining,
      counters.globalWorkRemaining,
    ) < p.workPerInstruction
  )
    return yield* fail("work_budget_exhausted");
  if (!counters.refundEnvelopeReady || !c.fees.gas_ready)
    return yield* fail("gas_budget_unavailable");
  const termsOrProspectus =
    c.quote.kind === "prospective" ? c.quote.prospective_terms : c.quote.committed_terms;
  const endsAt =
    c.quote.kind === "prospective"
      ? c.quote.prospective_terms.fixed_ends_at
      : c.quote.committed_terms.ends_at;
  if (
    a.schedule !== null &&
    (a.schedule.ruleHash !== c.schedule.rule_hash ||
      a.schedule.priceRuleHash !== c.schedule.price_rule_hash ||
      termsOrProspectus.planned_drawing_ids.some((id) => {
        const before = c.schedule.rows.find((r) => r.drawing_id === id);
        const current = a.schedule?.rows.find((r) => r.id === id);
        return (
          before === undefined ||
          current === undefined ||
          current.priceAtomic.toString() !== before.price_atomic ||
          current.drawingTime !== Date.parse(before.drawing_time) ||
          current.entryCutoff !== Date.parse(before.entry_cutoff_at) ||
          current.purchaseDeadline !== Date.parse(before.purchase_deadline_at)
        );
      }))
  )
    return yield* fail("context_stale");
  const capacity = songMegapotCapacity({
    now: Date.parse(now),
    profile: a.capacityProfile,
    schedule: a.schedule,
    plannedDrawingIds: termsOrProspectus.planned_drawing_ids,
    fixedEndsAt: Date.parse(endsAt),
    reservationDeadlineUpperBound: Date.parse(c.limits.reservation_deadline_upper_bound),
    budget: a.budget,
    outboundCostsReconciled: a.costsReconciled,
  });
  if (!capacity.ok) return yield* fail(capacity.reason);
  if (
    amount < BigInt(c.limits.minimum_atomic) ||
    (a.capacityProfile !== null && amount < a.capacityProfile.minimumAtomic)
  )
    return yield* fail("amount_below_minimum");
  if (amount > capacity.availableAtomic || amount > BigInt(c.limits.maximum_atomic))
    return yield* fail("capacity_exhausted");
  const deadline = new Date(
    Date.parse(now) + c.limits.reservation_ttl_seconds * 1_000,
  ).toISOString();
  if (
    deadline >= c.limits.reservation_deadline_upper_bound ||
    deadline >= endsAt ||
    a.capacityProfile === null ||
    a.capacityProfile.reservationMs !== c.limits.reservation_ttl_seconds * 1_000
  )
    return yield* fail("quote_expired");

  if (target === null || terms === null) {
    if (
      c.quote.kind !== "prospective" ||
      c.target.kind !== "empty" ||
      a.currentSlotGeneration !== c.target.slot_generation
    )
      return yield* fail("context_stale");
    const prospectus = c.quote.prospective_terms;
    const offerId = yield* tx.id("offer");
    const legId = yield* tx.id("leg");
    target = { ...prospectus.target, kind: "committed", offer_id: offerId, pool_leg_id: legId };
    const bindings = [];
    for (const t of prospectus.qualification_templates)
      bindings.push({
        ...t,
        binding_id: yield* tx.id("binding"),
        objective_id: yield* tx.id("objective"),
        offer_id: offerId,
        leg_id: legId,
      });
    const ordered = [...bindings].sort(
      (a, b) =>
        ["study", "karaoke", "dance"].indexOf(a.activity) -
        ["study", "karaoke", "dance"].indexOf(b.activity),
    );
    const bindingHash = yield* digestFundingPreimageV2(
      fundingHashPreimageV2(
        "pirate.shared-song-qualification-bindings.v1",
        ordered.map(projectQualificationBinding),
      ),
    );
    terms = {
      version: "shared-song-megapot-v2",
      profile_id: prospectus.profile_id,
      profile_hash: prospectus.profile_hash,
      terms_hash: "0".repeat(64),
      funding_policy_revision: prospectus.funding_policy_revision,
      funding_policy_hash: prospectus.funding_policy_hash,
      budget_source: "leg_budget",
      empty_behavior: "no_purchase",
      eligible_activities: ["study", "karaoke", "dance"],
      dance_scope: "any_policy_accepted",
      starts_at: now,
      ends_at: prospectus.fixed_ends_at,
      first_drawing_id: prospectus.first_drawing_id,
      last_planned_drawing_id: prospectus.last_planned_drawing_id,
      ticket_price_ceiling_atomic: prospectus.ticket_price_ceiling_atomic,
      disclosure_version: prospectus.disclosure_version,
      origin_prospective_terms_hash: c.quote.prospective_terms_hash,
      origin_slot_generation: c.target.slot_generation,
      reward_policy_hash: yield* tx.instantiateRewardPolicy(
        offerId,
        prospectus.reward_policy_template_hash,
      ),
      qualification_bindings: bindings,
      qualification_bindings_hash: bindingHash,
      planned_drawing_ids: prospectus.planned_drawing_ids,
      planned_schedule_hash: prospectus.planned_schedule_hash,
    };
    terms = {
      ...terms,
      terms_hash: yield* digestFundingPreimageV2(committedTermsPreimageV2(terms)),
    };
  }
  if ((yield* digestFundingPreimageV2(committedTermsPreimageV2(terms))) !== terms.terms_hash)
    return yield* fail("terms_mismatch");
  const contributionId = yield* tx.id("contribution");
  const effectId = yield* tx.id("effect");
  const reservationId = yield* tx.id("reservation");
  const nonceLeaseId = yield* tx.id("shared_nonce_lease");
  const stateHref = href(identity, contributionId);
  const calldata = `0xa9059cbb${c.custody_address.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
  const instruction = {
    kind: "erc20_transfer" as const,
    instruction_hash: "0".repeat(64),
    chain_id: c.chain_id,
    attestation_id: c.attestation_id,
    attestation_hash: c.schedule.anchor.attestation_hash,
    from: a.actor.sender_address,
    to_token: c.token_address,
    recipient_custody: c.custody_address,
    value_atomic: "0" as const,
    amount_atomic: amount.toString(),
    nonce: a.confirmedNonce,
    calldata,
    wallet_assignment_id: a.actor.wallet_assignment_id,
    wallet_index: a.actor.wallet_index,
    expires_at: deadline,
  };
  const instructionHash = yield* digestFundingPreimageV2(
    fundingHashPreimageV2("pirate.song-megapot-transfer-instruction.v2", [
      terms.terms_hash,
      projectCommittedTarget(target),
      contributionId,
      effectId,
      reservationId,
      0,
      nonceLeaseId,
      instruction.chain_id,
      instruction.attestation_id,
      instruction.attestation_hash,
      a.actor.persona_id,
      a.actor.wallet_assignment_id,
      a.actor.wallet_index,
      instruction.from,
      instruction.to_token,
      instruction.recipient_custody,
      "0",
      amount.toString(),
      instruction.nonce,
      calldata,
      c.schedule.anchor.block_number,
      c.schedule.anchor.block_hash,
      deadline,
    ]),
  );
  const receipt: ContributionReceiptV2 = {
    object: "song_megapot_contribution_command_receipt",
    version: 2,
    command_id: yield* tx.id("command"),
    request_hash: identity.hash,
    idempotency_key: identity.key,
    created_at: now,
    contribution_id: contributionId,
    funding_effect_id: effectId,
    target,
    persona_id: a.actor.persona_id,
    terms_hash: terms.terms_hash,
    reservation: {
      reservation_id: reservationId,
      revision: 0,
      amount_atomic: amount.toString(),
      valid_from_block_exclusive: c.schedule.anchor.block_number,
      deadline,
      disposition_rule_id: "receipt-chain-time-v3",
      nonce_lease_id: nonceLeaseId,
    },
    instruction: { ...instruction, instruction_hash: instructionHash },
    current_state_href: stateHref,
    observation_href: `${stateHref}/observations`,
    recovery_href: `${stateHref}/recoveries`,
    accepted_context_hash: c.context_hash,
    accepted_prospective_terms_hash:
      c.quote.kind === "prospective" ? c.quote.prospective_terms_hash : null,
    committed_terms: terms,
  };
  const state: ContributionState = {
    owner: a.actor,
    receipt,
    anchorBlockHash: c.schedule.anchor.block_hash,
    revision: 0,
    fundingState: "instruction_issued",
    effectiveDeadline: deadline,
    nonceFinalized: false,
    fundingGrant: null,
    cancellationGrant: null,
    cancellationHead: null,
    preparationsUsed: 0,
  };
  yield* tx.create(state, a);
  return receipt;
});

const validateSubmissionState = Effect.fn("SongMegapotContribution.validateSubmissionState")(
  function* (
    state: ContributionState,
    identity: Identity,
    request: FundingCommandV2<"ClaimSongMegapotContributionSubmissionV2">,
  ) {
    const cancel = request.purpose === "nonce_cancellation";
    if (
      state.owner.account_id !== identity.accountId ||
      state.receipt.contribution_id !== identity.contributionId ||
      state.receipt.target.community_id !== identity.communityId ||
      state.receipt.target.post_id !== identity.postId
    )
      return yield* fail("not_found");
    if (cancel && state.cancellationHead?.instruction_hash !== request.instruction_hash)
      return yield* fail("cancellation_plan_stale");
    if (
      (cancel ? state.cancellationGrant : state.fundingGrant) !== null ||
      (!cancel && state.cancellationGrant !== null)
    )
      return yield* fail("submission_already_claimed");
    if (request.expected_state_revision !== state.revision) return yield* fail("lifecycle_changed");
    if (state.nonceFinalized) return yield* fail("lifecycle_changed");
  },
);

const claimSubmission = Effect.fn("SongMegapotContribution.claimSubmission")(function* (
  tx: SongContributionTransaction,
  identity: Identity,
  request: FundingCommandV2<"ClaimSongMegapotContributionSubmissionV2">,
) {
  const observed = yield* tx.ownedContribution();
  yield* validateSubmissionState(observed, identity, request);
  const authority = yield* tx.recoveryAuthority(observed);
  // Another key can commit while this command waits for the existing fences.
  // Decide consumed-purpose versus genuine lifecycle refusal from locked state,
  // rather than sending the pre-wait snapshot to the SQL revision CAS.
  const state = yield* tx.ownedContribution();
  yield* validateSubmissionState(state, identity, request);
  const rawNow = yield* tx.now();
  const now = yield* parse(() => Schema.decodeUnknownSync(InstantV2)(rawNow));
  const original = state.receipt.instruction;
  const cancel = request.purpose === "nonce_cancellation";
  if (cancel && authority.policy === null) return yield* fail("cancellation_recovery_unavailable");
  if (!authority.originalWalletStillOwned) return yield* fail("persona_not_owned");
  if (authority.currentSigningRefusal !== null) return yield* fail(authority.currentSigningRefusal);
  if (now >= authority.attestationValidUntil) return yield* fail("attestation_unavailable");
  const plan = state.cancellationHead;
  if (cancel) {
    if (
      plan === null ||
      authority.policy === null ||
      authority.policy.policy_id !== plan.recovery_policy_id ||
      authority.policy.policy_hash !== plan.recovery_policy_hash ||
      authority.attestationId !== plan.recovery_attestation_id ||
      authority.attestationHash !== plan.recovery_attestation_hash ||
      authority.attestationValidUntil !== plan.recovery_attestation_valid_until ||
      now < authority.policy.valid_from ||
      now >= authority.policy.valid_until ||
      (yield* digestFundingPreimageV2(cancellationPolicyPreimageV2(authority.policy))) !==
        plan.recovery_policy_hash
    )
      return yield* fail("cancellation_recovery_unavailable");
    if (now < plan.prepared_at || now >= plan.dispatch_expires_at)
      return yield* fail("cancellation_plan_expired");
  } else if (
    request.instruction_hash !== original.instruction_hash ||
    now >= state.effectiveDeadline ||
    now >= original.expires_at
  )
    return yield* fail("instruction_expired");
  const receipt: SubmissionClaimReceiptV2 = {
    object: "contribution_submission_claim_receipt",
    version: 2,
    command_id: yield* tx.id("command"),
    request_hash: identity.hash,
    contribution_id: state.receipt.contribution_id,
    instruction_hash: request.instruction_hash,
    purpose: request.purpose,
    grant_id: yield* tx.id("grant"),
    grant_revision: state.revision + 1,
    holder_client_instance_id: request.client_instance_id,
    submission_attempt_id: request.submission_attempt_id,
    claimed_at: now,
    valid_until: cancel && plan !== null ? plan.dispatch_expires_at : original.expires_at,
    current_state_href: state.receipt.current_state_href,
    cancellation_preparation_id: cancel && plan !== null ? plan.preparation_id : null,
    cancellation_preparation_revision: cancel && plan !== null ? plan.preparation_revision : null,
  };
  yield* tx.update(
    state,
    {
      ...state,
      revision: state.revision + 1,
      fundingState: cancel ? state.fundingState : "submission_claimed",
      fundingGrant: cancel ? state.fundingGrant : receipt,
      cancellationGrant: cancel ? receipt : state.cancellationGrant,
    },
    { requestHash: identity.hash, receipt },
  );
  return receipt;
});

const prepareCancellation = Effect.fn("SongMegapotContribution.prepareCancellation")(function* (
  tx: SongContributionTransaction,
  identity: Identity,
  request: FundingCommandV2<"PrepareSongMegapotContributionCancellationV2">,
) {
  const state = yield* tx.ownedContribution();
  if (
    state.owner.account_id !== identity.accountId ||
    state.receipt.contribution_id !== identity.contributionId ||
    state.receipt.target.community_id !== identity.communityId ||
    state.receipt.target.post_id !== identity.postId
  )
    return yield* fail("not_found");
  if (state.cancellationGrant !== null) return yield* fail("submission_already_claimed");
  if (state.revision !== request.expected_state_revision || state.nonceFinalized)
    return yield* fail("lifecycle_changed");
  const rawNow = yield* tx.now();
  const now = yield* parse(() => Schema.decodeUnknownSync(InstantV2)(rawNow));
  if (state.cancellationHead !== null && now < state.cancellationHead.dispatch_expires_at)
    return yield* fail("cancellation_plan_stale");
  const a = yield* tx.recoveryAuthority(state);
  const p = a.policy;
  if (p !== null)
    yield* parse(() =>
      Schema.decodeUnknownSync(RecoveryPolicySchema, { onExcessProperty: "error" })(p),
    );
  if (
    p === null ||
    !a.originalWalletStillOwned ||
    a.currentSigningRefusal !== null ||
    now < p.valid_from ||
    now >= p.valid_until ||
    now >= a.attestationValidUntil ||
    p.chain_id !== state.receipt.instruction.chain_id ||
    (yield* digestFundingPreimageV2(cancellationPolicyPreimageV2(p))) !== p.policy_hash
  )
    return yield* fail("cancellation_recovery_unavailable");
  if (!a.boundedWorkAvailable) return yield* fail("work_budget_exhausted");
  if (state.preparationsUsed >= p.max_preparations_per_contribution)
    return yield* fail("cancellation_preparation_limit");
  const expires = new Date(
    Math.min(
      Date.parse(now) + p.dispatch_ttl_seconds * 1000,
      Date.parse(p.valid_until),
      Date.parse(a.attestationValidUntil),
    ),
  ).toISOString();
  if (expires <= now) return yield* fail("cancellation_recovery_unavailable");
  const i = state.receipt.instruction;
  let receipt: CancellationReceiptV2 = {
    object: "contribution_cancellation_command_receipt",
    version: 2,
    command_id: yield* tx.id("command"),
    request_hash: identity.hash,
    contribution_id: state.receipt.contribution_id,
    chain_id: i.chain_id,
    sender: i.from,
    recipient: i.from,
    nonce: i.nonce,
    value_atomic: "0",
    data: "0x",
    instruction_hash: "0".repeat(64),
    current_state_href: state.receipt.current_state_href,
    purpose: "nonce_cancellation",
    preparation_id: yield* tx.id("cancellation_plan"),
    preparation_revision: (state.cancellationHead?.preparation_revision ?? 0) + 1,
    previous_preparation_id: state.cancellationHead?.preparation_id ?? null,
    previous_preparation_instruction_hash: state.cancellationHead?.instruction_hash ?? null,
    prepared_state_revision: state.revision + 1,
    prepared_at: now,
    dispatch_expires_at: expires,
    original_funding_instruction_hash: i.instruction_hash,
    recovery_policy_id: p.policy_id,
    recovery_policy_hash: p.policy_hash,
    recovery_attestation_id: a.attestationId,
    recovery_attestation_hash: a.attestationHash,
    recovery_attestation_valid_until: a.attestationValidUntil,
    fee_policy_id: p.fee_policy_id,
    fee_policy_hash: p.fee_policy_hash,
    wallet_assignment_id: i.wallet_assignment_id,
    wallet_index: i.wallet_index,
  };
  receipt = {
    ...receipt,
    instruction_hash: yield* digestFundingPreimageV2(cancellationInstructionPreimageV2(receipt)),
  };
  yield* tx.update(
    state,
    {
      ...state,
      revision: state.revision + 1,
      cancellationHead: receipt,
      preparationsUsed: state.preparationsUsed + 1,
    },
    { requestHash: identity.hash, receipt },
  );
  return receipt;
});

const requestReconciliation = Effect.fn("SongMegapotContribution.requestReconciliation")(function* (
  tx: SongContributionTransaction,
  identity: Identity,
  request:
    | FundingCommandV2<"ObserveSongMegapotContributionV2">
    | FundingCommandV2<"RecoverSongMegapotContributionV2">,
) {
  const state = yield* tx.ownedContribution();
  if (
    state.owner.account_id !== identity.accountId ||
    state.receipt.contribution_id !== identity.contributionId ||
    state.receipt.target.community_id !== identity.communityId ||
    state.receipt.target.post_id !== identity.postId
  )
    return yield* fail("not_found");
  const common = {
    version: 2 as const,
    command_id: yield* tx.id("command"),
    request_hash: identity.hash,
    contribution_id: state.receipt.contribution_id,
    current_state_href: state.receipt.current_state_href,
  };
  let receipt: ObservationReceiptV2 | RecoveryReceiptV2;
  let hint: { instructionHash: string; transactionHash: string } | null = null;
  if ("transaction_hash" in request) {
    hint = { instructionHash: request.instruction_hash, transactionHash: request.transaction_hash };
    receipt = {
      ...common,
      object: "contribution_observation_command_receipt",
      accepted_candidate_hash: request.transaction_hash,
    };
  } else {
    if (request.expected_state_revision !== state.revision) return yield* fail("lifecycle_changed");
    receipt = {
      ...common,
      object: "contribution_recovery_command_receipt",
      work_item_id: yield* tx.id("work"),
      semantics: "reconcile_only_no_send",
    };
  }
  yield* tx.recordReconciliationRequest(state, { requestHash: identity.hash, receipt }, hint);
  return receipt;
});

/** Command acknowledgements and reconciliation enqueueing do not assert payment
 * truth or execute the held outgoing/refund interpreter. */
export function makeSongMegapotContributions(ports: SongContributionPorts) {
  const execute = Effect.fn("SongMegapotContribution.execute")(function* <
    O extends FundingOperationV2,
  >(operation: O, scope: FundingScope, rawBody: unknown) {
    const actor = yield* ports.authorize(scope);
    const request = yield* parse(() => decodeFundingCommandV2(operation, rawBody));
    const preimage = yield* parse(() =>
      fundingCommandPreimageV2(
        operation,
        actor.accountId,
        scope.communityId,
        scope.postId,
        scope.contributionId,
        request,
      ),
    );
    const hash = yield* digestFundingPreimageV2(preimage);
    const identity = {
      ...scope,
      accountId: actor.accountId,
      operation,
      key: request.idempotency_key,
      hash,
    };
    const deliver = (stored: StoredFundingCommand, replayed: boolean) => {
      if (stored.requestHash !== hash) return fail("idempotency_conflict");
      if (operation === "ClaimSongMegapotContributionSubmissionV2") {
        if (stored.receipt.object !== "contribution_submission_claim_receipt")
          return fail("outcome_unknown");
        const delivery: SubmissionClaimDeliveryV2 = {
          receipt: stored.receipt,
          delivery: replayed
            ? { kind: "recovery_only", replayed: true }
            : { kind: "fresh_grant", replayed: false },
        };
        return Effect.succeed(delivery);
      }
      return Effect.succeed(stored.receipt);
    };
    const replay = yield* ports.lookup(identity);
    if (replay !== null) return yield* deliver(replay, true);
    yield* ports.preflight(identity, request);
    return yield* ports.transaction(identity, (tx) =>
      Effect.gen(function* () {
        const lockedReplay = yield* tx.lookup();
        if (lockedReplay !== null) return yield* deliver(lockedReplay, true);
        let receipt: CommandReceipt;
        switch (operation) {
          case "ObserveSongMegapotContributionV2":
          case "RecoverSongMegapotContributionV2":
            receipt = yield* requestReconciliation(
              tx,
              identity,
              request as
                | FundingCommandV2<"ObserveSongMegapotContributionV2">
                | FundingCommandV2<"RecoverSongMegapotContributionV2">,
            );
            break;
          case "CreateSongMegapotContributionV2":
            receipt = yield* createContribution(tx, identity, request as ContributionRequestV2);
            break;
          case "ClaimSongMegapotContributionSubmissionV2":
            receipt = yield* claimSubmission(
              tx,
              identity,
              request as FundingCommandV2<"ClaimSongMegapotContributionSubmissionV2">,
            );
            break;
          case "PrepareSongMegapotContributionCancellationV2":
            receipt = yield* prepareCancellation(
              tx,
              identity,
              request as FundingCommandV2<"PrepareSongMegapotContributionCancellationV2">,
            );
            break;
        }
        return yield* deliver({ requestHash: hash, receipt }, false);
      }),
    );
  });
  return { execute };
}
