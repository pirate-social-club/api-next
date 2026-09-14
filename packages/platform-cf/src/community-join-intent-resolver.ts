import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  type VerificationIntentResolver,
  VerificationProviderPlanInput,
  VerificationStartStorageFailed,
} from "@pirate/application/verification";
import {
  COMMUNITY_GATE_COMPILER_VERSION,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  communityJoinActionPayloadHash,
  communityJoinIntentBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  nationalityProviderBindingHash,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_ISSUER,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";
import { GatesV2CommunityDataInvalid, loadCuratedNationalityPolicy } from "./gates-v2-community.ts";
import {
  NationalityCeremonyDataInvalid,
  resolveOrIssueNationalityCeremony,
} from "./nationality-ceremony-store.ts";

type Row = Readonly<Record<string, unknown>>;

type JoinIntentRow = Readonly<{
  readonly action_intent_id: unknown;
  readonly user_id: unknown;
  readonly community_id: unknown;
  readonly action_kind: unknown;
  readonly action_scope: unknown;
  readonly action_payload_hash: unknown;
  readonly intent_binding_hash: unknown;
  readonly status: unknown;
  readonly start_authorized: unknown;
}>;

type JoinNationalityIntentRow = Readonly<{
  readonly ceremony_intent_id: unknown;
  readonly actor_id: unknown;
  readonly intent_id: unknown;
  readonly generation: unknown;
  readonly requirement_hash: unknown;
  readonly provider_id: unknown;
  readonly provider_binding_hash: unknown;
  readonly reservation_request: unknown;
  readonly state_status: unknown;
  readonly state_generation: unknown;
  readonly state_requirement_hash: unknown;
  readonly current_ceremony_intent_id: unknown;
}>;

const CANONICAL_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;
const CANONICAL_CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;
const CANONICAL_COMPILED_PLAN = {
  compiler_version: COMMUNITY_GATE_COMPILER_VERSION,
  evaluator: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
  provider_binding: {
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    method: VERY_WEB_METHOD,
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
  },
} as const;
const BOUND_SESSION_REPLAY_SQL = `session.provider_id = $11
  AND session.provider_configuration_kind = 'dynamic'
  AND session.provider_configuration_ref = $12
  AND session.provider_configuration_version = $13
  AND session.method = $14
  AND session.protocol_version = $15
  AND session.issuer = $16
  AND session.scope_kind = 'issuer_rp_scope'
  AND session.issuer_rp_scope = $17
  AND session.issuer_rp_action_scope IS NULL
  AND session.request_mode = 'dynamic'
  AND session.requested_requirements = $18::jsonb
  AND session.requested_claim_ids = $19::jsonb
  AND session.subject_binding_intent = 'establish'
  AND session.environment = $20
  AND (
    session.status = 'completed'
    OR (session.status = 'pending' AND session.expires_at > clock_timestamp())
  )`;

/** Ceremony lifetime for the joiner's nationality child ceremony; not evidence lifetime. */
const COMMUNITY_JOIN_NATIONALITY_CEREMONY_TTL_SECONDS = 3_600;

export type CommunityJoinIntentResolverRuntime = Readonly<{
  readonly withTransaction: <A>(
    use: (
      transaction: ControlPlaneTransaction,
    ) => Effect.Effect<A, ControlPlaneError | VerificationStartStorageFailed>,
  ) => Effect.Effect<A, VerificationStartStorageFailed>;
}>;

export type CommunityJoinIntentResolverOptions = Readonly<{
  readonly next_ceremony_intent_id?: () => string;
}>;

function storageFailure(): VerificationStartStorageFailed {
  return new VerificationStartStorageFailed();
}

function validEnvironment(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function canonicalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("\u0000")
  );
}

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function oneRow<RowType>(result: ControlPlaneResult<RowType>): RowType | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function plan(environment: string): unknown {
  return {
    method: VERY_WEB_METHOD,
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: VERY_WEB_ISSUER,
      rp_scope: VERY_WEB_RP_SCOPE,
    },
    requested_requirements: CANONICAL_REQUIREMENTS,
    requested_claim_ids: CANONICAL_CLAIM_IDS,
    subject_binding_intent: "establish",
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
    environment,
    verification_purpose: {
      intent: "community_join",
      policy_id: CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
    },
  };
}

function resolvePalmIntent(
  transaction: ControlPlaneTransaction,
  environment: string,
  input: Readonly<{
    readonly actor_id: string;
    readonly intent_id: string;
    readonly provider_id: string;
  }>,
): Effect.Effect<boolean, ControlPlaneError | VerificationStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<JoinIntentRow>({
      label: "community.join.resolve-verification-intent",
      text: `SELECT intent.action_intent_id,
                   intent.user_id,
                   intent.community_id,
                   intent.action_kind,
                   intent.action_scope,
                   intent.action_payload_hash,
                   intent.intent_binding_hash,
                   intent.status,
                   (
                     intent.expires_at > clock_timestamp()
                     OR (${BOUND_SESSION_REPLAY_SQL})
                   ) AS start_authorized
              FROM action_intents AS intent
              JOIN communities AS community
                ON community.community_id = intent.community_id
              LEFT JOIN proof_sessions AS session
                ON session.actor_id = intent.user_id
               AND session.intent_id = intent.action_intent_id
              JOIN community_policy_current AS current_policy
                ON current_policy.community_id = community.community_id
               AND current_policy.policy_key = $3
               AND current_policy.policy_version_id = $4
              JOIN policy_versions AS policy
                ON policy.community_id = current_policy.community_id
               AND policy.policy_key = current_policy.policy_key
               AND policy.policy_version_id = current_policy.policy_version_id
              JOIN community_policy_provider_bindings AS binding
                ON binding.community_id = policy.community_id
               AND binding.policy_key = policy.policy_key
               AND binding.policy_version_id = policy.policy_version_id
             WHERE intent.action_intent_id = $1
               AND intent.user_id = $2
               AND intent.action_kind = 'community_join'
               AND intent.action_scope = intent.community_id
               AND intent.status = 'open'
               AND (
                 intent.expires_at > clock_timestamp()
                 OR (${BOUND_SESSION_REPLAY_SQL})
               )
               AND community.status = 'active'
               AND community.membership_mode = 'gated'
               AND community.human_verification_lane = 'very'
               AND policy.revision = $7
               AND policy.policy_hash = $5
               AND policy.policy = $8::jsonb
               AND policy.compiled_plan = $9::jsonb
               AND policy.compiler_version = $10
               AND policy.policy_purpose = 'access'
               AND binding.verification_requirement_hash = $6
               AND binding.provider_id = $11
               AND binding.provider_configuration_kind = 'dynamic'
               AND binding.provider_configuration_ref = $12
               AND binding.provider_configuration_version = $13
               AND binding.method = $14
               AND binding.protocol_version = $15
               AND binding.issuer = $16
               AND binding.scope_kind = 'issuer_rp_scope'
               AND binding.issuer_rp_scope = $17
               AND binding.issuer_rp_action_scope IS NULL
               AND binding.request_mode = 'dynamic'
               AND binding.evaluator_id = $4`,
      values: [
        input.intent_id,
        input.actor_id,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
        HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
        CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
        JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
        JSON.stringify(CANONICAL_COMPILED_PLAN),
        COMMUNITY_GATE_COMPILER_VERSION,
        VERY_WEB_PROVIDER_ID,
        VERY_WEB_CONFIGURATION_REFERENCE,
        VERY_WEB_CONFIGURATION_VERSION,
        VERY_WEB_METHOD,
        VERY_WEB_PROTOCOL_VERSION,
        VERY_WEB_ISSUER,
        VERY_WEB_RP_SCOPE,
        JSON.stringify(CANONICAL_REQUIREMENTS),
        JSON.stringify(CANONICAL_CLAIM_IDS),
        environment,
      ],
      readonly: true,
    });
    if (result.rows.length > 1) return yield* Effect.fail(storageFailure());
    const row = result.rows[0];
    if (row === undefined) return false;
    if (
      row.action_intent_id !== input.intent_id ||
      row.user_id !== input.actor_id ||
      typeof row.community_id !== "string" ||
      row.community_id.length === 0 ||
      row.action_kind !== "community_join" ||
      row.action_scope !== row.community_id ||
      row.action_payload_hash !== communityJoinActionPayloadHash(row.community_id) ||
      row.intent_binding_hash !==
        communityJoinIntentBindingHash({
          actorId: input.actor_id,
          communityId: row.community_id,
        }) ||
      row.status !== "open" ||
      row.start_authorized !== true
    ) {
      return yield* Effect.fail(storageFailure());
    }
    return true;
  });
}

function resolveNationalityIntent(
  transaction: ControlPlaneTransaction,
  options: CommunityJoinIntentResolverOptions,
  input: Readonly<{
    readonly actor_id: string;
    readonly intent_id: string;
    readonly provider_id: string;
  }>,
): Effect.Effect<unknown, ControlPlaneError | VerificationStartStorageFailed> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<JoinNationalityIntentRow>({
      label: "community.join.resolve-nationality-intent",
      text: `SELECT attempt.ceremony_intent_id,
                    attempt.actor_id,
                    attempt.intent_id,
                    attempt.generation,
                    attempt.requirement_hash,
                    attempt.provider_id,
                    attempt.provider_binding_hash,
                    attempt.reservation_request,
                    state.status AS state_status,
                    state.generation AS state_generation,
                    state.requirement_hash AS state_requirement_hash,
                    state.current_ceremony_intent_id
               FROM nationality_ceremony_attempts AS attempt
               JOIN nationality_requirement_states AS state
                 ON state.action_kind = attempt.action_kind
                AND state.intent_id = attempt.intent_id
                AND state.requirement_kind = attempt.requirement_kind
              WHERE attempt.ceremony_intent_id = $1
                AND attempt.actor_id = $2
                AND attempt.action_kind = 'community_join'
                AND attempt.requirement_kind = 'nationality'
              FOR UPDATE OF state`,
      values: [input.intent_id, input.actor_id],
      readonly: false,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(storageFailure());
    if (row === null) return null;

    const generation = positiveInteger(row.generation);
    const stateGeneration = positiveInteger(row.state_generation);
    if (
      row.actor_id !== input.actor_id ||
      row.state_status !== "pending" ||
      generation === null ||
      stateGeneration === null ||
      generation !== stateGeneration ||
      row.current_ceremony_intent_id !== input.intent_id ||
      row.state_requirement_hash !== row.requirement_hash ||
      !canonicalId(row.intent_id)
    ) {
      return null;
    }

    const reservation = jsonValue(row.reservation_request);
    if (reservation === null || typeof reservation !== "object" || Array.isArray(reservation)) {
      return null;
    }
    const record = reservation as Row;
    const communityId = record.community_id;
    const reservationIntentId = record.intent_id;
    if (
      record.action_kind !== "community_join" ||
      record.actor_id !== input.actor_id ||
      record.requirement_hash !== row.requirement_hash ||
      !canonicalId(communityId) ||
      reservationIntentId !== row.intent_id
    ) {
      return null;
    }

    const policy = yield* loadCuratedNationalityPolicy(transaction, communityId).pipe(
      Effect.mapError((error) =>
        error instanceof GatesV2CommunityDataInvalid ? storageFailure() : error,
      ),
    );
    if (policy === null || policy.requirement_hash !== row.requirement_hash) return null;
    const selected = policy.provider_bindings.find(
      (binding) => binding.provider_id === input.provider_id,
    );
    if (selected === undefined) return null;
    const selectedBindingHash = nationalityProviderBindingHash(selected);
    if (
      row.provider_id === input.provider_id &&
      row.provider_binding_hash !== selectedBindingHash
    ) {
      return null;
    }

    const storeOptions =
      options.next_ceremony_intent_id === undefined
        ? {}
        : { nextCeremonyIntentId: options.next_ceremony_intent_id };
    const action = yield* resolveOrIssueNationalityCeremony(
      transaction,
      {
        actionKind: "community_join",
        intentId: row.intent_id as string,
        actorId: input.actor_id,
        requirementHash: row.requirement_hash as string,
        acceptedProviderIds: ["self.pass", "zkpassport"],
        selectedProviderId: input.provider_id,
        selectedBinding: {
          bindingHash: selectedBindingHash,
          configurationKind: selected.provider_configuration.kind,
          configurationRef: selected.provider_configuration.reference,
          configurationVersion: selected.provider_configuration.version,
        },
        reservationRequest: {
          action_kind: "community_join",
          actor_id: input.actor_id,
          community_id: communityId,
          intent_id: row.intent_id,
          requirement_hash: row.requirement_hash,
          provider_id: input.provider_id,
          provider_binding_hash: selectedBindingHash,
        },
        ttlSeconds: COMMUNITY_JOIN_NATIONALITY_CEREMONY_TTL_SECONDS,
      },
      storeOptions,
    ).pipe(
      Effect.mapError((error) =>
        error instanceof NationalityCeremonyDataInvalid ? storageFailure() : error,
      ),
    );

    const decoded = Schema.decodeUnknownOption(VerificationProviderPlanInput)({
      method: selected.method,
      scope: selected.scope,
      requested_requirements: [policy.requirement],
      requested_claim_ids: ["nationality.allowed"],
      subject_binding_intent: "establish",
      protocol_version: selected.protocol_version,
      environment: selected.environment,
      verification_purpose: {
        intent: "community_join",
        policy_id: policy.policy_version_id,
      },
    });
    return Option.isSome(decoded)
      ? { ...decoded.value, resolved_intent_id: action.ceremonyIntentId }
      : yield* Effect.fail(storageFailure());
  });
}

export function makeCommunityJoinIntentResolver(
  runtime: CommunityJoinIntentResolverRuntime,
  environment: string,
  options: CommunityJoinIntentResolverOptions = {},
): VerificationIntentResolver {
  const decodedPlan = Schema.decodeUnknownOption(VerificationProviderPlanInput)(plan(environment));
  if (!validEnvironment(environment) || Option.isNone(decodedPlan)) {
    return { resolve: () => Effect.fail(storageFailure()) };
  }
  return {
    resolve: (input) =>
      Effect.gen(function* () {
        if (!("intent_id" in input)) return null;
        if (input.provider_id === VERY_WEB_PROVIDER_ID) {
          const found = yield* runtime.withTransaction((transaction) =>
            resolvePalmIntent(transaction, environment, {
              actor_id: input.actor_id,
              intent_id: input.intent_id,
              provider_id: input.provider_id,
            }),
          );
          return found ? decodedPlan.value : null;
        }
        if (input.provider_id === "self.pass" || input.provider_id === "zkpassport") {
          return yield* runtime.withTransaction((transaction) =>
            resolveNationalityIntent(transaction, options, {
              actor_id: input.actor_id,
              intent_id: input.intent_id,
              provider_id: input.provider_id,
            }),
          );
        }
        return null;
      }),
  };
}

export function makeControlPlaneCommunityJoinIntentResolver(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  environment: string,
  options: CommunityJoinIntentResolverOptions = {},
): VerificationIntentResolver {
  return makeCommunityJoinIntentResolver(
    {
      withTransaction: <A>(
        use: (
          transaction: ControlPlaneTransaction,
        ) => Effect.Effect<A, ControlPlaneError | VerificationStartStorageFailed>,
      ) =>
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* db.withTransaction(use);
        }).pipe(
          Effect.provide(runtime),
          Effect.mapError(() => storageFailure()),
        ),
    },
    environment,
    options,
  );
}
