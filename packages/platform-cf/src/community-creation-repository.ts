import {
  type CommitCommunityCreationIntentResult,
  type CommunityCreationIntentDocument,
  CommunityCreationRepositoryError,
  type CommunityCreationRepositoryFailure,
  type CommunityCreationStore,
  type CommunityCreationStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type CreateCommunityCreationIntentResult,
  publicCommunityCreationRequirements,
} from "@pirate/application";
import { VerificationCompletionStorageFailed } from "@pirate/application/verification";
import {
  CommitCommunityCreationIntent,
  CommunityCreationIntent as CommunityCreationIntentContract,
  CreateCommunityCreationIntent,
  UpdateCommunityCreationIntent,
} from "@pirate/contracts";
import {
  COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  type CommunityCreationIntentState,
  type CommunityCreationProviderBinding,
  type CreationRequirementProgress,
  CURATED_HUMAN_MEMBERSHIP_POLICY,
  canonicalRouteView,
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  communityNamespaceRequirementHash,
  compileCommunityGatePolicy,
  creationNextAction,
  deriveCommunityRoute,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  transitionCommunityCreationIntent,
  transitionCreationRequirement,
  VERY_OAUTH_CONFIGURATION_REFERENCE,
  VERY_OAUTH_CONFIGURATION_VERSION,
  VERY_OAUTH_ISSUER,
  VERY_OAUTH_METHOD,
  VERY_OAUTH_PROTOCOL_VERSION,
  VERY_OAUTH_PROVIDER_ID,
  VERY_OAUTH_RP_SCOPE,
} from "@pirate/domain";
import { Effect, type Layer, Option, Schema } from "effect";

type Row = Readonly<Record<string, unknown>>;

export const COMMUNITY_CREATION_INTENT_TTL_SECONDS = 24 * 60 * 60;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const UNRESOLVED_PROVIDER_ID = "unresolved";
const UNRESOLVED_PROVIDER_CONFIGURATION = "unresolved";
const VERY_OAUTH_EVIDENCE_KIND = "very.oauth.id-token-userinfo.v1";
const TERMINAL_STATUSES = new Set([
  "committed",
  "quota_exceeded",
  "gate_unsupported",
  "expired",
  "cancelled",
]);

const HUMAN_MEMBERSHIP_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;
const HUMAN_MEMBERSHIP_CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;

export type CommunityCreationVerificationAdvanceOutcome =
  | Readonly<{ readonly kind: "advanced"; readonly intent_id: string; readonly revision: number }>
  | Readonly<{
      readonly kind: "already_ready";
      readonly intent_id: string;
      readonly revision: number;
    }>
  | Readonly<{ readonly kind: "not_applicable" }>
  | Readonly<{
      readonly kind: "stale";
      readonly reason:
        | "intent_expired"
        | "intent_terminal"
        | "intent_not_verification_required"
        | "session_binding_drift"
        | "evidence_invalid";
    }>;

export type CommunityCreationRepositoryOptions = Readonly<{
  readonly intent_ttl_seconds?: number;
  readonly next_intent_id?: () => string;
  readonly next_community_id?: () => string;
  readonly next_route_binding_id?: () => string;
  readonly next_subject_claim_id?: () => string;
  readonly next_ceremony_intent_id?: () => string;
  readonly namespace_provider_bindings?: readonly CommunityCreationProviderBinding[];
}>;

type IntentBinding = Readonly<{
  readonly providerId: string;
  readonly configurationKind: "managed" | "dynamic";
  readonly configurationReference: string;
  readonly configurationVersion: string;
}>;

type CompiledDraft = Readonly<{
  readonly status: "verification_required" | "gate_unsupported";
  readonly canonicalPolicyHash: string;
  readonly verificationRequirementHash: string;
  readonly binding: IntentBinding;
  readonly route: Readonly<{
    readonly family: "hns" | "spaces";
    readonly root_label: string;
    readonly root_label_display: string;
    readonly path_segment: string;
    readonly href: string;
  }>;
  readonly namespaceRequirementHash: string;
  readonly humanProviderBindingHash: string;
  readonly namespaceBinding: Readonly<{
    readonly providerId: string;
    readonly providerBindingHash: string;
    readonly configurationKind: "managed" | "dynamic";
    readonly configurationReference: string;
    readonly configurationVersion: string;
    readonly protocolVersion: string;
  }>;
}>;

function failure(
  operation: "create" | "get" | "update" | "commit",
  reason: "not-found" | "idempotency-conflict" | "revision-conflict" | "constraint" | "invalid-row",
): CommunityCreationRepositoryError {
  return new CommunityCreationRepositoryError({ operation, reason });
}

function validId(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function oneRow(rows: readonly Row[]): Row | null | undefined {
  if (rows.length > 1) return undefined;
  return rows[0] ?? null;
}

function compileDraft(
  policy: unknown,
  routeRequest: Readonly<{ readonly family: "hns" | "spaces"; readonly root_label: string }>,
  namespaceBindings: readonly CommunityCreationProviderBinding[],
): CompiledDraft | null {
  const compilation = compileCommunityGatePolicy(policy);
  const route = deriveCommunityRoute(routeRequest);
  const namespaceRequirement = communityNamespaceRequirementHash(routeRequest);
  if (route.kind === "rejected" || namespaceRequirement.kind === "rejected") return null;

  const humanBinding: CommunityCreationProviderBinding = {
    requirement: "human_identity",
    family: null,
    provider_id: VERY_OAUTH_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
      version: VERY_OAUTH_CONFIGURATION_VERSION,
    },
    protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
  };
  const unresolvedHumanBinding: CommunityCreationProviderBinding = {
    requirement: "human_identity",
    family: null,
    provider_id: UNRESOLVED_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: UNRESOLVED_PROVIDER_CONFIGURATION,
      version: "1",
    },
    protocol_version: "unresolved",
  };
  // Route contracts accept both families, but the persisted ownership
  // ceremony is HNS-only until the separately gated Spaces adapter exists.
  // Ignore injected Spaces bindings so unsupported runtime authority fails
  // closed instead of creating an intent that cannot complete.
  const namespaceBinding =
    route.value.family === "hns"
      ? namespaceBindings.find(
          (candidate) =>
            candidate.requirement === "namespace_ownership" && candidate.family === "hns",
        )
      : undefined;
  const unresolvedNamespaceBinding: CommunityCreationProviderBinding = {
    requirement: "namespace_ownership",
    family: route.value.family,
    provider_id: UNRESOLVED_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic",
      reference: UNRESOLVED_PROVIDER_CONFIGURATION,
      version: "1",
    },
    protocol_version: "unresolved",
  };
  const selectedNamespaceBinding = namespaceBinding ?? unresolvedNamespaceBinding;
  const selectedHumanBinding =
    compilation.kind === "supported" ? humanBinding : unresolvedHumanBinding;
  let humanProviderBindingHash: string;
  let namespaceProviderBindingHash: string;
  try {
    humanProviderBindingHash = communityCreationProviderBindingHash(selectedHumanBinding);
    namespaceProviderBindingHash = communityCreationProviderBindingHash(selectedNamespaceBinding);
  } catch {
    return null;
  }

  const supported = compilation.kind === "supported" && namespaceBinding !== undefined;
  return {
    status: supported ? "verification_required" : "gate_unsupported",
    canonicalPolicyHash: compilation.canonical_policy_hash,
    verificationRequirementHash: compilation.verification_requirement_hash,
    binding: {
      providerId: selectedHumanBinding.provider_id,
      configurationKind: selectedHumanBinding.provider_configuration.kind,
      configurationReference: selectedHumanBinding.provider_configuration.reference,
      configurationVersion: selectedHumanBinding.provider_configuration.version,
    },
    route: route.value,
    namespaceRequirementHash: namespaceRequirement.value,
    humanProviderBindingHash,
    namespaceBinding: {
      providerId: selectedNamespaceBinding.provider_id,
      providerBindingHash: namespaceProviderBindingHash,
      configurationKind: selectedNamespaceBinding.provider_configuration.kind,
      configurationReference: selectedNamespaceBinding.provider_configuration.reference,
      configurationVersion: selectedNamespaceBinding.provider_configuration.version,
      protocolVersion: selectedNamespaceBinding.protocol_version,
    },
  };
}

function requirementFromValue(
  value: unknown,
  requirement: "human_identity" | "namespace_ownership",
): CreationRequirementProgress | null {
  const record = jsonValue(value);
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const row = record as Row;
  const generation = asNonNegativeInteger(row.generation);
  const satisfiedAt = row.satisfied_at === null ? null : asTimestamp(row.satisfied_at);
  const progress: CreationRequirementProgress = {
    requirement,
    status: asString(row.status) as CreationRequirementProgress["status"],
    requirement_hash: asString(row.requirement_hash) ?? "",
    provider_id: asString(row.provider_id) ?? "",
    provider_binding_hash: asString(row.provider_binding_hash) ?? "",
    generation: generation ?? -1,
    ceremony_intent_id:
      row.current_ceremony_intent_id === null
        ? null
        : (asString(row.current_ceremony_intent_id) ?? ""),
    satisfied_at: satisfiedAt,
  };
  try {
    return publicCommunityCreationRequirements({
      human_identity:
        requirement === "human_identity"
          ? progress
          : {
              ...progress,
              requirement: "human_identity",
            },
      namespace_ownership:
        requirement === "namespace_ownership"
          ? progress
          : {
              ...progress,
              requirement: "namespace_ownership",
            },
    })
      ? progress
      : null;
  } catch {
    return null;
  }
}

function nextActionFromRequirements(
  row: Row,
  input: Readonly<{
    readonly intentId: string;
    readonly status: string;
    readonly human: CreationRequirementProgress;
    readonly namespace: CreationRequirementProgress;
  }>,
) {
  if (input.status === "draft") {
    return { kind: "wait", requirement: null, reason_code: "operation_pending" } as const;
  }
  if (input.status === "verification_required") {
    for (const [requirement, progress, started] of [
      ["human_identity", input.human, row.human_started === true],
      ["namespace_ownership", input.namespace, row.namespace_started === true],
    ] as const) {
      if (progress.status !== "pending") continue;
      return started
        ? ({
            kind: "wait",
            requirement,
            reason_code: "verification_pending",
          } as const)
        : ({
            kind: "start_verification",
            requirement,
            provider_id: progress.provider_id,
            creation_intent_id: input.intentId,
            ceremony_intent_id: progress.ceremony_intent_id ?? "",
            generation: progress.generation,
          } as const);
    }
    return { kind: "wait", requirement: null, reason_code: "reconciliation_pending" } as const;
  }
  if (input.status === "commit_ready") return { kind: "commit" } as const;
  if (input.status === "quota_exceeded" || input.status === "gate_unsupported") {
    return { kind: "blocked", reason: input.status } as const;
  }
  if (input.status === "committed" || input.status === "expired" || input.status === "cancelled") {
    return { kind: "none", reason: input.status } as const;
  }
  return null;
}

function documentFromRow(row: Row): CommunityCreationIntentDocument | null {
  const intentId = asString(row.intent_id);
  const revision = asPositiveInteger(row.revision);
  const status = asString(row.status);
  const canonicalPolicyRevision = asPositiveInteger(row.canonical_policy_revision);
  const canonicalPolicyHash = asString(row.canonical_policy_hash);
  const requirementHash = asString(row.verification_requirement_hash);
  const providerId = asString(row.verification_provider_id);
  const expiresAt = asTimestamp(row.expires_at);
  const human = requirementFromValue(row.human_requirement, "human_identity");
  const namespace = requirementFromValue(row.namespace_requirement, "namespace_ownership");
  if (
    intentId === null ||
    revision === null ||
    status === null ||
    canonicalPolicyRevision === null ||
    canonicalPolicyHash === null ||
    requirementHash === null ||
    providerId === null ||
    expiresAt === null ||
    human === null ||
    namespace === null ||
    row.creation_contract_version !== "route_v1"
  ) {
    return null;
  }
  const nextAction = nextActionFromRequirements(row, {
    intentId,
    status,
    human,
    namespace,
  });
  if (nextAction === null) return null;
  let committedResource: CommunityCreationIntentState["committed_resource"] &
    CommunityCreationIntentDocument["committed_resource"] = null;
  if (row.committed_community_id !== null || row.committed_resource_href !== null) {
    const family = asString(row.committed_route_family);
    const rootLabel = asString(row.committed_route_root_label);
    const rootLabelDisplay = asString(row.committed_route_root_label_display);
    const pathSegment = asString(row.committed_route_path_segment);
    const href = asString(row.committed_route_href);
    if (
      (family !== "hns" && family !== "spaces") ||
      rootLabel === null ||
      rootLabelDisplay === null ||
      pathSegment === null ||
      href === null
    ) {
      return null;
    }
    const route = canonicalRouteView(
      {
        family,
        root_label: rootLabel,
        root_label_display: rootLabelDisplay,
        path_segment: pathSegment,
        href,
      },
      row.committed_app_host_healthy === true,
    );
    committedResource = {
      community_id: asString(row.committed_community_id) ?? "",
      href: asString(row.committed_resource_href) ?? "",
      canonical_route: route,
    };
  }
  const state: CommunityCreationIntentState = {
    intent_id: intentId,
    revision,
    status: status as CommunityCreationIntentState["status"],
    canonical_policy_revision: canonicalPolicyRevision,
    canonical_policy_hash: canonicalPolicyHash,
    verification_requirement_hash: requirementHash,
    verification_provider_id: providerId,
    expires_at: expiresAt,
    committed_resource: committedResource,
  };
  const decoded = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
    intent_id: state.intent_id,
    revision: state.revision,
    status: state.status,
    draft: jsonValue(row.draft),
    canonical_policy_revision: state.canonical_policy_revision,
    canonical_policy_hash: state.canonical_policy_hash,
    requirements: publicCommunityCreationRequirements({
      human_identity: human,
      namespace_ownership: namespace,
    }),
    next_action: nextAction,
    expires_at: state.expires_at,
    committed_resource: state.committed_resource,
  });
  return Option.isSome(decoded) ? decoded.value : null;
}

function stateFromDocument(
  document: CommunityCreationIntentDocument,
  providerId: string,
): CommunityCreationIntentState {
  return {
    intent_id: document.intent_id,
    revision: document.revision,
    status: document.status,
    canonical_policy_revision: document.canonical_policy_revision,
    canonical_policy_hash: document.canonical_policy_hash,
    verification_requirement_hash: document.requirements.human_identity.requirement_hash,
    verification_provider_id: document.requirements.human_identity.provider_id || providerId,
    expires_at: document.expires_at,
    committed_resource: document.committed_resource,
  };
}

function decodeSnapshot(value: unknown): CommunityCreationIntentDocument | null {
  const decoded = Schema.decodeUnknownOption(CommunityCreationIntentContract)(jsonValue(value));
  return Option.isSome(decoded) ? decoded.value : null;
}

function rowColumns(prefix = ""): string {
  const column = (name: string) => `${prefix}${name}`;
  return `${column("intent_id")}, ${column("actor_id")}, ${column("create_idempotency_key")}, ${column("create_request_hash")},
          ${column("revision")}, ${column("status")}, ${column("draft")}, ${column("canonical_policy_revision")},
          ${column("canonical_policy_hash")}, ${column("verification_requirement_hash")},
          ${column("verification_provider_id")}, ${column("provider_configuration_kind")},
          ${column("provider_configuration_ref")}, ${column("provider_configuration_version")},
          ${column("expires_at")}, ${column("committed_community_id")}, ${column("committed_resource_href")},
          ${column("creation_contract_version")}`;
}

function routeV1ProjectionColumns(intentAlias: string): string {
  const requirement = (kind: "human_identity" | "namespace_ownership") => `(
    SELECT jsonb_build_object(
      'status', state.status,
      'requirement_hash', state.requirement_hash,
      'provider_id', state.provider_id,
      'provider_binding_hash', state.provider_binding_hash,
      'generation', state.generation,
      'current_ceremony_intent_id', state.current_ceremony_intent_id,
      'satisfied_at', state.satisfied_at
    )
      FROM community_creation_requirement_states AS state
     WHERE state.intent_id = ${intentAlias}.intent_id
       AND state.requirement_kind = '${kind}'
  )`;
  return `${requirement("human_identity")} AS human_requirement,
          ${requirement("namespace_ownership")} AS namespace_requirement,
          EXISTS (
            SELECT 1 FROM proof_sessions AS proof
             WHERE proof.creation_ceremony_intent_id = (
               SELECT state.current_ceremony_intent_id
                 FROM community_creation_requirement_states AS state
                WHERE state.intent_id = ${intentAlias}.intent_id
                  AND state.requirement_kind = 'human_identity'
             )
          ) AS human_started,
          EXISTS (
            SELECT 1 FROM namespace_ownership_sessions AS namespace_session
             WHERE namespace_session.ceremony_intent_id = (
               SELECT state.current_ceremony_intent_id
                 FROM community_creation_requirement_states AS state
                WHERE state.intent_id = ${intentAlias}.intent_id
                  AND state.requirement_kind = 'namespace_ownership'
             )
          ) AS namespace_started,
          binding.family AS committed_route_family,
          binding.root_label AS committed_route_root_label,
          binding.root_label_display AS committed_route_root_label_display,
          binding.path_segment AS committed_route_path_segment,
          binding.href AS committed_route_href,
          host.health_status = 'healthy' AS committed_app_host_healthy`;
}

function lockActor(
  transaction: ControlPlaneTransaction,
  actorId: string,
  operation: "create" | "update" | "commit",
): Effect.Effect<void, CommunityCreationRepositoryFailure> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${operation}.lock-actor`,
      text: "SELECT user_id FROM users WHERE user_id = $1 AND status = 'active' FOR UPDATE",
      values: [actorId],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(failure(operation, "invalid-row"));
    if (row === null || row.user_id !== actorId) {
      return yield* Effect.fail(failure(operation, "constraint"));
    }
  });
}

function loadLockedIntent(
  transaction: ControlPlaneTransaction,
  actorId: string,
  intentId: string,
  operation: "create" | "get" | "update" | "commit",
  databaseNow?: string,
) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${operation}.lock-intent`,
      text: `SELECT ${rowColumns("intent.")},
                    ${routeV1ProjectionColumns("intent")},
                    intent.expires_at <= COALESCE($3::timestamptz, clock_timestamp()) AS expired
               FROM community_creation_intents AS intent
               LEFT JOIN communities AS committed_community
                 ON committed_community.community_id = intent.committed_community_id
               LEFT JOIN community_canonical_route_bindings AS binding
                 ON binding.route_binding_id = committed_community.canonical_route_binding_id
                AND binding.community_id = committed_community.community_id
               LEFT JOIN community_route_app_host_health AS host
                 ON host.route_binding_id = binding.route_binding_id
              WHERE intent.intent_id = $1 AND intent.actor_id = $2
                AND intent.creation_contract_version = 'route_v1'
              FOR UPDATE OF intent`,
      values: [intentId, actorId, databaseNow ?? null],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(failure(operation, "invalid-row"));
    return row;
  });
}

function replayByKey(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly operation: "create" | "update" | "commit";
    readonly actorId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly intentId?: string;
  }>,
) {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${input.operation}.load-replay`,
      text: `SELECT revision.intent_id, revision.request_hash, revision.state_snapshot
               FROM community_creation_intent_revisions AS revision
               JOIN community_creation_intents AS intent
                 ON intent.intent_id = revision.intent_id
                AND intent.actor_id = revision.actor_id
              WHERE revision.actor_id = $1
                AND revision.operation_kind = $2
                AND revision.idempotency_key = $3
                AND intent.creation_contract_version = 'route_v1'
              FOR UPDATE OF revision`,
      values: [input.actorId, input.operation, input.idempotencyKey],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) {
      return yield* Effect.fail(failure(input.operation, "invalid-row"));
    }
    if (row === null) return null;
    if (
      row.request_hash !== input.requestHash ||
      (input.intentId !== undefined && row.intent_id !== input.intentId)
    ) {
      return yield* Effect.fail(failure(input.operation, "idempotency-conflict"));
    }
    const snapshot = decodeSnapshot(row.state_snapshot);
    return snapshot === null
      ? yield* Effect.fail(failure(input.operation, "invalid-row"))
      : snapshot;
  });
}

function insertRevision(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly intent: CommunityCreationIntentDocument;
    readonly actorId: string;
    readonly operation: "create" | "update" | "verification" | "commit" | "expire";
    readonly idempotencyKey?: string;
    readonly requestHash: string;
  }>,
) {
  return transaction.execute({
    label: `community.creation.${input.operation}.insert-revision`,
    text: `INSERT INTO community_creation_intent_revisions (
             intent_id, revision, actor_id, operation_kind, idempotency_key,
             request_hash, status, state_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    values: [
      input.intent.intent_id,
      input.intent.revision,
      input.actorId,
      input.operation,
      input.idempotencyKey ?? null,
      input.requestHash,
      input.intent.status,
      JSON.stringify(input.intent),
    ],
    readonly: false,
  });
}

function insertInitialCreationRequirements(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actorId: string;
    readonly intentId: string;
    readonly ceremonyIntentId: string;
    readonly compiled: CompiledDraft;
  }>,
): Effect.Effect<void, CommunityCreationRepositoryFailure> {
  return Effect.gen(function* () {
    yield* transaction.execute({
      label: "community.creation.create.insert-requirements",
      text: `INSERT INTO community_creation_requirement_states (
               intent_id, actor_id, requirement_kind, status,
               requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, route_family, route_root_label,
               route_root_label_display, route_path_segment, generation
             ) VALUES
             ($1, $2, 'human_identity', 'unmet', $3, $4, $5, $6, $7, $8,
              NULL, NULL, NULL, NULL, 0),
             ($1, $2, 'namespace_ownership', 'unmet', $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, 0)`,
      values: [
        input.intentId,
        input.actorId,
        input.compiled.verificationRequirementHash,
        input.compiled.binding.providerId,
        input.compiled.humanProviderBindingHash,
        input.compiled.binding.configurationKind,
        input.compiled.binding.configurationReference,
        input.compiled.binding.configurationVersion,
        input.compiled.namespaceRequirementHash,
        input.compiled.namespaceBinding.providerId,
        input.compiled.namespaceBinding.providerBindingHash,
        input.compiled.namespaceBinding.configurationKind,
        input.compiled.namespaceBinding.configurationReference,
        input.compiled.namespaceBinding.configurationVersion,
        input.compiled.route.family,
        input.compiled.route.root_label,
        input.compiled.route.root_label_display,
        input.compiled.route.path_segment,
      ],
      readonly: false,
    });

    if (input.compiled.status !== "verification_required") return;
    const reservation = {
      actor_id: input.actorId,
      creation_intent_id: input.intentId,
      ceremony_intent_id: input.ceremonyIntentId,
      requirement: "human_identity" as const,
      generation: 1,
      requirement_hash: input.compiled.verificationRequirementHash,
      provider_id: input.compiled.binding.providerId,
      provider_binding_hash: input.compiled.humanProviderBindingHash,
      route: null,
    };
    const reservationRequest = {
      ...reservation,
      version: COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
    };
    let reservationHash: string;
    try {
      reservationHash = communityCreationCeremonyReservationHash(reservation);
    } catch {
      return yield* Effect.fail(failure("create", "constraint"));
    }
    yield* transaction.execute({
      label: "community.creation.create.reserve-human-ceremony",
      text: `INSERT INTO community_creation_ceremony_attempts (
               ceremony_intent_id, actor_id, intent_id, requirement_kind,
               generation, requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, route_family, route_root_label,
               route_root_label_display, route_path_segment,
               reservation_request_hash, reservation_request, expires_at
             )
             SELECT $1, $2, $3, 'human_identity', 1, $4, $5, $6, $7, $8, $9,
                    NULL, NULL, NULL, NULL, $10, $11::jsonb, intent.expires_at
               FROM community_creation_intents AS intent
              WHERE intent.intent_id = $3 AND intent.actor_id = $2
                AND intent.creation_contract_version = 'route_v1'`,
      values: [
        input.ceremonyIntentId,
        input.actorId,
        input.intentId,
        input.compiled.verificationRequirementHash,
        input.compiled.binding.providerId,
        input.compiled.humanProviderBindingHash,
        input.compiled.binding.configurationKind,
        input.compiled.binding.configurationReference,
        input.compiled.binding.configurationVersion,
        reservationHash,
        JSON.stringify(reservationRequest),
      ],
      readonly: false,
    });
    const advanced = yield* transaction.execute({
      label: "community.creation.create.advance-human-requirement",
      text: `UPDATE community_creation_requirement_states
                SET status = 'pending', generation = 1,
                    current_ceremony_intent_id = $1,
                    updated_at = clock_timestamp()
              WHERE intent_id = $2 AND actor_id = $3
                AND requirement_kind = 'human_identity'
                AND status = 'unmet' AND generation = 0`,
      values: [input.ceremonyIntentId, input.intentId, input.actorId],
      readonly: false,
    });
    if (advanced.rowCount !== 1) {
      return yield* Effect.fail(failure("create", "invalid-row"));
    }
  });
}

function reserveNextCreationRequirement(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actorId: string;
    readonly intentId: string;
    readonly ceremonyIntentId: string;
    readonly operation: "get" | "update";
  }>,
): Effect.Effect<"reserved" | "pending" | "complete", CommunityCreationRepositoryFailure> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community.creation.${input.operation}.lock-requirements`,
      text: `SELECT requirement_kind, status, requirement_hash, provider_id,
                    provider_binding_hash, provider_configuration_kind,
                    provider_configuration_ref, provider_configuration_version,
                    route_family, route_root_label, route_root_label_display,
                    route_path_segment, generation, current_ceremony_intent_id
               FROM community_creation_requirement_states
              WHERE intent_id = $1 AND actor_id = $2
              ORDER BY CASE requirement_kind
                WHEN 'human_identity' THEN 1
                WHEN 'namespace_ownership' THEN 2
              END
              FOR UPDATE`,
      values: [input.intentId, input.actorId],
      readonly: false,
    });
    if (result.rows.length !== 2) {
      return yield* Effect.fail(failure(input.operation, "invalid-row"));
    }
    if (result.rows.some((row) => row.status === "pending")) return "pending";
    const selected = result.rows.find((row) => row.status !== "satisfied");
    if (selected === undefined) return "complete";

    const requirement = asString(selected.requirement_kind);
    const generation = asNonNegativeInteger(selected.generation);
    const requirementHash = asString(selected.requirement_hash);
    const providerId = asString(selected.provider_id);
    const providerBindingHash = asString(selected.provider_binding_hash);
    const configurationKind = asString(selected.provider_configuration_kind);
    const configurationReference = asString(selected.provider_configuration_ref);
    const configurationVersion = asString(selected.provider_configuration_version);
    if (
      (requirement !== "human_identity" && requirement !== "namespace_ownership") ||
      generation === null ||
      requirementHash === null ||
      providerId === null ||
      providerBindingHash === null ||
      (configurationKind !== "managed" && configurationKind !== "dynamic") ||
      configurationReference === null ||
      configurationVersion === null ||
      !validId(input.ceremonyIntentId)
    ) {
      return yield* Effect.fail(failure(input.operation, "invalid-row"));
    }
    const route =
      requirement === "namespace_ownership"
        ? {
            family: asString(selected.route_family) as "hns" | "spaces",
            root_label: asString(selected.route_root_label) ?? "",
            root_label_display: asString(selected.route_root_label_display) ?? "",
            path_segment: asString(selected.route_path_segment) ?? "",
          }
        : null;
    if (
      route !== null &&
      (route.family !== "hns" ||
        route.root_label.length === 0 ||
        route.root_label_display.length === 0 ||
        route.path_segment.length === 0)
    ) {
      return yield* Effect.fail(failure(input.operation, "constraint"));
    }
    const nextGeneration = generation + 1;
    const reservation = {
      actor_id: input.actorId,
      creation_intent_id: input.intentId,
      ceremony_intent_id: input.ceremonyIntentId,
      requirement,
      generation: nextGeneration,
      requirement_hash: requirementHash,
      provider_id: providerId,
      provider_binding_hash: providerBindingHash,
      route,
    } as const;
    let reservationHash: string;
    try {
      reservationHash = communityCreationCeremonyReservationHash(reservation);
    } catch {
      return yield* Effect.fail(failure(input.operation, "constraint"));
    }
    yield* transaction.execute({
      label: `community.creation.${input.operation}.reserve-ceremony`,
      text: `INSERT INTO community_creation_ceremony_attempts (
               ceremony_intent_id, actor_id, intent_id, requirement_kind,
               generation, requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_kind, provider_configuration_ref,
               provider_configuration_version, route_family, route_root_label,
               route_root_label_display, route_path_segment,
               reservation_request_hash, reservation_request, expires_at
             )
             SELECT $1, state.actor_id, state.intent_id, state.requirement_kind,
                    $2, state.requirement_hash, state.provider_id,
                    state.provider_binding_hash, state.provider_configuration_kind,
                    state.provider_configuration_ref, state.provider_configuration_version,
                    state.route_family, state.route_root_label,
                    state.route_root_label_display, state.route_path_segment,
                    $3, $4::jsonb, intent.expires_at
               FROM community_creation_requirement_states AS state
               JOIN community_creation_intents AS intent
                 ON intent.intent_id = state.intent_id AND intent.actor_id = state.actor_id
              WHERE state.intent_id = $5 AND state.actor_id = $6
                AND state.requirement_kind = $7
                AND state.status IN ('unmet', 'failed', 'expired')
                AND state.generation = $8
                AND intent.creation_contract_version = 'route_v1'
                AND intent.expires_at > clock_timestamp()`,
      values: [
        input.ceremonyIntentId,
        nextGeneration,
        reservationHash,
        JSON.stringify({
          ...reservation,
          version: COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
        }),
        input.intentId,
        input.actorId,
        requirement,
        generation,
      ],
      readonly: false,
    });
    const advanced = yield* transaction.execute({
      label: `community.creation.${input.operation}.advance-requirement`,
      text: `UPDATE community_creation_requirement_states
                SET status = 'pending', generation = $1,
                    current_ceremony_intent_id = $2, satisfied_at = NULL,
                    updated_at = clock_timestamp()
              WHERE intent_id = $3 AND actor_id = $4
                AND requirement_kind = $5
                AND status IN ('unmet', 'failed', 'expired')
                AND generation = $6`,
      values: [
        nextGeneration,
        input.ceremonyIntentId,
        input.intentId,
        input.actorId,
        requirement,
        generation,
      ],
      readonly: false,
    });
    if (advanced.rowCount !== 1) {
      return yield* Effect.fail(failure(input.operation, "invalid-row"));
    }
    return "reserved";
  });
}

function replaceCreationRequirementBindings(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actorId: string;
    readonly intentId: string;
    readonly compiled: CompiledDraft;
  }>,
): Effect.Effect<void, CommunityCreationRepositoryFailure> {
  return Effect.gen(function* () {
    const human = yield* transaction.execute({
      label: "community.creation.update.replace-human-binding",
      text: `UPDATE community_creation_requirement_states
                SET status = 'unmet', requirement_hash = $1, provider_id = $2,
                    provider_binding_hash = $3, provider_configuration_kind = $4,
                    provider_configuration_ref = $5,
                    provider_configuration_version = $6,
                    current_ceremony_intent_id = NULL, satisfied_at = NULL,
                    updated_at = clock_timestamp()
              WHERE intent_id = $7 AND actor_id = $8
                AND requirement_kind = 'human_identity'
                AND ROW(
                  requirement_hash, provider_id, provider_binding_hash,
                  provider_configuration_kind, provider_configuration_ref,
                  provider_configuration_version
                ) IS DISTINCT FROM ROW($1, $2, $3, $4, $5, $6)`,
      values: [
        input.compiled.verificationRequirementHash,
        input.compiled.binding.providerId,
        input.compiled.humanProviderBindingHash,
        input.compiled.binding.configurationKind,
        input.compiled.binding.configurationReference,
        input.compiled.binding.configurationVersion,
        input.intentId,
        input.actorId,
      ],
      readonly: false,
    });
    const namespace = yield* transaction.execute({
      label: "community.creation.update.replace-namespace-binding",
      text: `UPDATE community_creation_requirement_states
                SET status = 'unmet', requirement_hash = $1, provider_id = $2,
                    provider_binding_hash = $3, provider_configuration_kind = $4,
                    provider_configuration_ref = $5,
                    provider_configuration_version = $6, route_family = $7,
                    route_root_label = $8, route_root_label_display = $9,
                    route_path_segment = $10, current_ceremony_intent_id = NULL,
                    satisfied_at = NULL, updated_at = clock_timestamp()
              WHERE intent_id = $11 AND actor_id = $12
                AND requirement_kind = 'namespace_ownership'
                AND ROW(
                  requirement_hash, provider_id, provider_binding_hash,
                  provider_configuration_kind, provider_configuration_ref,
                  provider_configuration_version, route_family, route_root_label,
                  route_root_label_display, route_path_segment
                ) IS DISTINCT FROM ROW($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      values: [
        input.compiled.namespaceRequirementHash,
        input.compiled.namespaceBinding.providerId,
        input.compiled.namespaceBinding.providerBindingHash,
        input.compiled.namespaceBinding.configurationKind,
        input.compiled.namespaceBinding.configurationReference,
        input.compiled.namespaceBinding.configurationVersion,
        input.compiled.route.family,
        input.compiled.route.root_label,
        input.compiled.route.root_label_display,
        input.compiled.route.path_segment,
        input.intentId,
        input.actorId,
      ],
      readonly: false,
    });
    if (human.rowCount > 1 || namespace.rowCount > 1) {
      return yield* Effect.fail(failure("update", "invalid-row"));
    }
  });
}

function verificationStorageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
}

function exactCanonicalJson(value: unknown, expected: unknown): boolean {
  return JSON.stringify(jsonValue(value)) === JSON.stringify(expected);
}

type CommitEvidence = Readonly<{
  readonly proofSessionId: string;
  readonly evidenceReceiptId: string;
  readonly evidenceDigest: string;
  readonly subjectKeyId: string;
  readonly subjectDigest: string;
  readonly receiptExpiresAt: string | null;
  readonly assertionExpiresAt: string | null;
}>;

function loadCommitEvidence(
  transaction: ControlPlaneTransaction,
  input: Readonly<{ readonly actorId: string; readonly proofSessionId: string }>,
): Effect.Effect<CommitEvidence | null, ControlPlaneError> {
  return Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "community.creation.commit.validate-evidence",
      text: `SELECT
               MIN(receipt.evidence_receipt_id) AS evidence_receipt_id,
               MIN(receipt.evidence_hash) AS evidence_digest,
               MIN(receipt.subject_key_id) AS subject_key_id,
               MIN(subject.subject_digest) AS subject_digest,
               MIN(receipt.expires_at) AS receipt_expires_at,
               MIN(assertion.expires_at) AS assertion_expires_at,
               (
                 COUNT(DISTINCT receipt.evidence_receipt_id) = 1
                 AND COUNT(DISTINCT receipt.subject_key_id) = 1
                 AND COUNT(assertion.assertion_id) = 2
                 AND COUNT(DISTINCT assertion.binding_group_id) = 1
                 AND COUNT(*) FILTER (
                   WHERE assertion.claim_id = 'human.personhood'
                     AND assertion.assertion_value = '{"personhood": true}'::jsonb
                     AND assertion.assurance = 'provider_attested'
                 ) = 1
                 AND COUNT(*) FILTER (
                   WHERE assertion.claim_id = 'credential.subject_unique'
                     AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
                     AND assertion.assurance = 'provider_attested'
                 ) = 1
                 AND BOOL_AND(
                   receipt.user_id = session.actor_id
                   AND receipt.provider_id = session.provider_id
                   AND receipt.provider_configuration_kind = session.provider_configuration_kind
                   AND receipt.provider_configuration_ref = session.provider_configuration_ref
                   AND receipt.provider_configuration_version = session.provider_configuration_version
                   AND receipt.issuer = session.issuer
                   AND receipt.method = session.method
                   AND receipt.scope_kind = session.scope_kind
                   AND receipt.issuer_rp_scope IS NOT DISTINCT FROM session.issuer_rp_scope
                   AND receipt.issuer_rp_action_scope IS NOT DISTINCT FROM session.issuer_rp_action_scope
                   AND receipt.protocol_version = session.protocol_version
                   AND receipt.environment = session.environment
                   AND receipt.provenance_kind = 'proof_session'
                   AND receipt.evidence_kind = $2
                   AND receipt.subject_key_id IS NOT NULL
                   AND receipt.subject_binding_event_id IS NOT NULL
                   AND receipt.subject_binding_epoch IS NOT NULL
                   AND receipt.observed_at <= session.terminal_at
                   AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
                   AND active_binding.subject_key_id = receipt.subject_key_id
                   AND active_binding.binding_event_id = receipt.subject_binding_event_id
                   AND active_binding.binding_epoch = receipt.subject_binding_epoch
                   AND active_binding.user_id = session.actor_id
                   AND subject.subject_key_id = receipt.subject_key_id
                   AND assertion.user_id = session.actor_id
                   AND assertion.evidence_receipt_id = receipt.evidence_receipt_id
                   AND assertion.subject_key_id = receipt.subject_key_id
                   AND assertion.observed_at <= session.terminal_at
                   AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
                   AND assertion_binding.user_id = session.actor_id
                   AND assertion_binding.binding_mode = 'same_subject'
                   AND assertion_binding.subject_key_id = receipt.subject_key_id
                   AND assertion_binding.evidence_receipt_id IS NULL
                   AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
                   AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
                 )
               ) AS evidence_valid
          FROM proof_sessions AS session
          LEFT JOIN evidence_receipts AS receipt
            ON receipt.proof_session_id = session.proof_session_id
          LEFT JOIN assertions AS assertion
            ON assertion.evidence_receipt_id = receipt.evidence_receipt_id
          LEFT JOIN assertion_bindings AS assertion_binding
            ON assertion_binding.binding_group_id = assertion.binding_group_id
          LEFT JOIN active_subject_key_bindings AS active_binding
            ON active_binding.subject_key_id = receipt.subject_key_id
          LEFT JOIN subject_keys AS subject
            ON subject.subject_key_id = receipt.subject_key_id
         WHERE session.proof_session_id = $1
           AND session.actor_id = $3`,
      values: [input.proofSessionId, VERY_OAUTH_EVIDENCE_KIND, input.actorId],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined || row === null || row.evidence_valid !== true) return null;
    const evidenceReceiptId = asString(row.evidence_receipt_id);
    const evidenceDigest = asString(row.evidence_digest);
    const subjectKeyId = asString(row.subject_key_id);
    const subjectDigest = asString(row.subject_digest);
    const receiptExpiresAt =
      row.receipt_expires_at === null ? null : asTimestamp(row.receipt_expires_at);
    const assertionExpiresAt =
      row.assertion_expires_at === null ? null : asTimestamp(row.assertion_expires_at);
    if (
      evidenceReceiptId === null ||
      !SHA256_HEX.test(evidenceDigest ?? "") ||
      subjectKeyId === null ||
      !SHA256_HEX.test(subjectDigest ?? "") ||
      (row.receipt_expires_at !== null && receiptExpiresAt === null) ||
      (row.assertion_expires_at !== null && assertionExpiresAt === null)
    ) {
      return null;
    }
    return {
      proofSessionId: input.proofSessionId,
      evidenceReceiptId,
      evidenceDigest: evidenceDigest ?? "",
      subjectKeyId,
      subjectDigest: subjectDigest ?? "",
      receiptExpiresAt,
      assertionExpiresAt,
    };
  });
}

/**
 * Settle a completed canonical Very ceremony against its creation intent.
 *
 * The helper deliberately preserves valid generic/stale evidence: only a
 * storage or constraint failure aborts the surrounding completion transaction.
 * Replays may call it again to repair a completion produced before the intent
 * revision was appended.
 */
export function advanceCommunityCreationVerificationInTransaction(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly proof_session_id: string;
    readonly result_hash: string;
  }>,
): Effect.Effect<
  CommunityCreationVerificationAdvanceOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    if (
      !validId(input.actor_id) ||
      !validId(input.proof_session_id) ||
      !SHA256_HEX.test(input.result_hash)
    ) {
      return yield* Effect.fail(verificationStorageFailure());
    }

    const sessionResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.lock-session",
      text: `SELECT proof_session_id, actor_id, intent_id, provider_id,
                    provider_configuration_kind, provider_configuration_ref,
                    provider_configuration_version, method, issuer, scope_kind,
                    issuer_rp_scope, issuer_rp_action_scope, request_mode,
                    requested_requirements, requested_claim_ids,
                    subject_binding_intent, protocol_version, environment,
                    status, expires_at, completed_at, terminal_at,
                    completion_idempotency_key, completion_result_hash,
                    creation_ceremony_intent_id
               FROM proof_sessions
              WHERE proof_session_id = $1 AND actor_id = $2
              FOR UPDATE`,
      values: [input.proof_session_id, input.actor_id],
      readonly: false,
    });
    const session = oneRow(sessionResult.rows);
    if (session === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (session === null) return { kind: "not_applicable" } as const;

    const ceremonyIntentId = asString(session.creation_ceremony_intent_id);
    const completedAt = asTimestamp(session.completed_at);
    const terminalAt = asTimestamp(session.terminal_at);
    const sessionExpiresAt = asTimestamp(session.expires_at);
    if (
      ceremonyIntentId === null ||
      session.proof_session_id !== input.proof_session_id ||
      session.actor_id !== input.actor_id ||
      session.intent_id !== ceremonyIntentId ||
      session.status !== "completed" ||
      session.completion_result_hash !== input.result_hash ||
      asString(session.completion_idempotency_key) === null ||
      completedAt === null ||
      terminalAt === null ||
      sessionExpiresAt === null ||
      completedAt !== terminalAt ||
      Date.parse(completedAt) >= Date.parse(sessionExpiresAt)
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const authorityResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.lock-authority",
      text: `SELECT attempt.intent_id,
                    attempt.requirement_kind AS attempt_requirement_kind,
                    attempt.generation AS attempt_generation,
                    attempt.requirement_hash AS attempt_requirement_hash,
                    attempt.provider_id AS attempt_provider_id,
                    attempt.provider_binding_hash AS attempt_provider_binding_hash,
                    attempt.provider_configuration_kind AS attempt_configuration_kind,
                    attempt.provider_configuration_ref AS attempt_configuration_ref,
                    attempt.provider_configuration_version AS attempt_configuration_version,
                    attempt.route_family AS attempt_route_family,
                    attempt.expires_at AS attempt_expires_at,
                    state.status AS requirement_status,
                    state.generation AS requirement_generation,
                    state.requirement_hash,
                    state.provider_id,
                    state.provider_binding_hash,
                    state.provider_configuration_kind,
                    state.provider_configuration_ref,
                    state.provider_configuration_version,
                    state.current_ceremony_intent_id,
                    state.route_family
               FROM community_creation_ceremony_attempts AS attempt
               JOIN community_creation_requirement_states AS state
                 ON state.intent_id = attempt.intent_id
                AND state.actor_id = attempt.actor_id
                AND state.requirement_kind = attempt.requirement_kind
              WHERE attempt.ceremony_intent_id = $1
                AND attempt.actor_id = $2
                AND attempt.requirement_kind = 'human_identity'
              FOR UPDATE OF attempt, state`,
      values: [ceremonyIntentId, input.actor_id],
      readonly: false,
    });
    const authority = oneRow(authorityResult.rows);
    if (authority === undefined) return yield* Effect.fail(verificationStorageFailure());
    if (authority === null) return { kind: "not_applicable" } as const;
    const intentId = asString(authority.intent_id);
    const generation = asPositiveInteger(authority.attempt_generation);
    const requirementHash = asString(authority.attempt_requirement_hash);
    const providerId = asString(authority.attempt_provider_id);
    const providerBindingHash = asString(authority.attempt_provider_binding_hash);
    const configurationVersion = asString(authority.attempt_configuration_version);
    const attemptExpiresAt = asTimestamp(authority.attempt_expires_at);
    const expectedProviderBindingHash = communityCreationProviderBindingHash({
      requirement: "human_identity",
      family: null,
      provider_id: VERY_OAUTH_PROVIDER_ID,
      provider_configuration: {
        kind: "dynamic",
        reference: VERY_OAUTH_CONFIGURATION_REFERENCE,
        version: VERY_OAUTH_CONFIGURATION_VERSION,
      },
      protocol_version: VERY_OAUTH_PROTOCOL_VERSION,
    });
    if (
      intentId === null ||
      generation === null ||
      requirementHash !== HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH ||
      providerId !== VERY_OAUTH_PROVIDER_ID ||
      providerBindingHash !== expectedProviderBindingHash ||
      configurationVersion !== VERY_OAUTH_CONFIGURATION_VERSION ||
      attemptExpiresAt === null ||
      Date.parse(completedAt) >= Date.parse(attemptExpiresAt) ||
      authority.attempt_requirement_kind !== "human_identity" ||
      authority.attempt_configuration_kind !== "dynamic" ||
      authority.attempt_configuration_ref !== VERY_OAUTH_CONFIGURATION_REFERENCE ||
      authority.attempt_route_family !== null ||
      Number(authority.requirement_generation) !== generation ||
      authority.requirement_hash !== requirementHash ||
      authority.provider_id !== providerId ||
      authority.provider_binding_hash !== providerBindingHash ||
      authority.provider_configuration_kind !== authority.attempt_configuration_kind ||
      authority.provider_configuration_ref !== authority.attempt_configuration_ref ||
      authority.provider_configuration_version !== configurationVersion ||
      authority.current_ceremony_intent_id !== ceremonyIntentId ||
      authority.route_family !== null
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const intentRow = yield* loadLockedIntent(transaction, input.actor_id, intentId, "get").pipe(
      Effect.mapError(() => verificationStorageFailure()),
    );
    if (intentRow === null) return { kind: "not_applicable" } as const;
    const document = documentFromRow(intentRow);
    if (document === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (TERMINAL_STATUSES.has(document.status)) {
      return { kind: "stale", reason: "intent_terminal" } as const;
    }
    if (intentRow.expired === true) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }

    const exactBinding =
      document.requirements.human_identity.requirement_hash ===
        HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH &&
      session.provider_id === providerId &&
      session.provider_configuration_kind === authority.attempt_configuration_kind &&
      session.provider_configuration_ref === authority.attempt_configuration_ref &&
      session.provider_configuration_version === configurationVersion &&
      session.method === VERY_OAUTH_METHOD &&
      session.issuer === VERY_OAUTH_ISSUER &&
      session.scope_kind === "issuer_rp_scope" &&
      session.issuer_rp_scope === VERY_OAUTH_RP_SCOPE &&
      session.issuer_rp_action_scope === null &&
      session.request_mode === "dynamic" &&
      exactCanonicalJson(session.requested_requirements, HUMAN_MEMBERSHIP_REQUIREMENTS) &&
      exactCanonicalJson(session.requested_claim_ids, HUMAN_MEMBERSHIP_CLAIM_IDS) &&
      session.subject_binding_intent === "establish" &&
      session.protocol_version === VERY_OAUTH_PROTOCOL_VERSION &&
      asString(session.environment) !== null;
    if (!exactBinding) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    if (authority.requirement_status === "satisfied") {
      if (document.status !== "verification_required" && document.status !== "commit_ready") {
        return { kind: "stale", reason: "intent_not_verification_required" } as const;
      }
      const replayResult = yield* transaction.execute<Row>({
        label: "community.creation.verification.load-result-replay",
        text: `SELECT proof_session_id, callback_idempotency_key, callback_request_hash,
                      outcome_status, result_hash, terminal_at, satisfied_at
                 FROM community_creation_ceremony_results
                WHERE ceremony_intent_id = $1 AND actor_id = $2`,
        values: [ceremonyIntentId, input.actor_id],
        readonly: false,
      });
      const replay = oneRow(replayResult.rows);
      if (
        replay === undefined ||
        replay === null ||
        replay.proof_session_id !== input.proof_session_id ||
        replay.callback_idempotency_key !== session.completion_idempotency_key ||
        replay.callback_request_hash !== input.result_hash ||
        replay.outcome_status !== "satisfied" ||
        replay.result_hash !== input.result_hash ||
        asTimestamp(replay.terminal_at) !== completedAt ||
        asTimestamp(replay.satisfied_at) !== completedAt
      ) {
        return { kind: "stale", reason: "session_binding_drift" } as const;
      }
      return {
        kind: "already_ready",
        intent_id: document.intent_id,
        revision: document.revision,
      } as const;
    }
    if (document.status !== "verification_required") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }
    if (authority.requirement_status !== "pending") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }

    const evidenceResult = yield* transaction.execute<Row>({
      label: "community.creation.verification.validate-evidence",
      text: `SELECT (
               COUNT(DISTINCT receipt.evidence_receipt_id) = 1
               AND COUNT(assertion.assertion_id) = 2
               AND COUNT(DISTINCT assertion.binding_group_id) = 1
               AND COUNT(*) FILTER (
                 WHERE assertion.claim_id = 'human.personhood'
                   AND assertion.assertion_value = '{"personhood": true}'::jsonb
                   AND assertion.assurance = 'provider_attested'
               ) = 1
               AND COUNT(*) FILTER (
                 WHERE assertion.claim_id = 'credential.subject_unique'
                   AND assertion.assertion_value = '{"subject_unique": true}'::jsonb
                   AND assertion.assurance = 'provider_attested'
               ) = 1
               AND BOOL_AND(
                 receipt.user_id = session.actor_id
                 AND receipt.provider_id = session.provider_id
                 AND receipt.provider_configuration_kind = session.provider_configuration_kind
                 AND receipt.provider_configuration_ref = session.provider_configuration_ref
                 AND receipt.provider_configuration_version = session.provider_configuration_version
                 AND receipt.issuer = session.issuer
                 AND receipt.method = session.method
                 AND receipt.scope_kind = session.scope_kind
                 AND receipt.issuer_rp_scope IS NOT DISTINCT FROM session.issuer_rp_scope
                 AND receipt.issuer_rp_action_scope IS NOT DISTINCT FROM session.issuer_rp_action_scope
                 AND receipt.protocol_version = session.protocol_version
                 AND receipt.environment = session.environment
                 AND receipt.provenance_kind = 'proof_session'
                 AND receipt.evidence_kind = $2
                 AND receipt.subject_key_id IS NOT NULL
                 AND receipt.subject_binding_event_id IS NOT NULL
                 AND receipt.subject_binding_epoch IS NOT NULL
                 AND receipt.observed_at <= session.terminal_at
                 AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
                 AND active_binding.subject_key_id = receipt.subject_key_id
                 AND active_binding.binding_event_id = receipt.subject_binding_event_id
                 AND active_binding.binding_epoch = receipt.subject_binding_epoch
                 AND active_binding.user_id = session.actor_id
                 AND assertion.user_id = session.actor_id
                 AND assertion.evidence_receipt_id = receipt.evidence_receipt_id
                 AND assertion.subject_key_id = receipt.subject_key_id
                 AND assertion.observed_at <= session.terminal_at
                 AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
                 AND assertion_binding.user_id = session.actor_id
                 AND assertion_binding.binding_mode = 'same_subject'
                 AND assertion_binding.subject_key_id = receipt.subject_key_id
                 AND assertion_binding.evidence_receipt_id IS NULL
                 AND assertion_binding.subject_binding_event_id = receipt.subject_binding_event_id
                 AND assertion_binding.subject_binding_epoch = receipt.subject_binding_epoch
               )
             ) AS evidence_valid
        FROM proof_sessions AS session
        LEFT JOIN evidence_receipts AS receipt
          ON receipt.proof_session_id = session.proof_session_id
        LEFT JOIN assertions AS assertion
          ON assertion.evidence_receipt_id = receipt.evidence_receipt_id
        LEFT JOIN assertion_bindings AS assertion_binding
          ON assertion_binding.binding_group_id = assertion.binding_group_id
        LEFT JOIN active_subject_key_bindings AS active_binding
          ON active_binding.subject_key_id = receipt.subject_key_id
       WHERE session.proof_session_id = $1
         AND session.actor_id = $3`,
      values: [input.proof_session_id, VERY_OAUTH_EVIDENCE_KIND, input.actor_id],
      readonly: false,
    });
    const evidenceRow = oneRow(evidenceResult.rows);
    if (evidenceRow === undefined || evidenceRow === null) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    if (evidenceRow.evidence_valid !== true) {
      return { kind: "stale", reason: "evidence_invalid" } as const;
    }

    const evidence = yield* loadCommitEvidence(transaction, {
      actorId: input.actor_id,
      proofSessionId: input.proof_session_id,
    });
    if (evidence === null) {
      return { kind: "stale", reason: "evidence_invalid" } as const;
    }

    const transitioned = transitionCreationRequirement(
      {
        requirement: "human_identity",
        status: "pending",
        requirement_hash: requirementHash,
        provider_id: providerId,
        provider_binding_hash: providerBindingHash,
        generation,
        ceremony_intent_id: ceremonyIntentId,
        satisfied_at: null,
      },
      {
        type: "ceremony_satisfied",
        generation,
        ceremony_intent_id: ceremonyIntentId,
        satisfied_at: completedAt,
      },
    );
    if (transitioned.kind === "rejected") {
      return yield* Effect.fail(verificationStorageFailure());
    }
    const insertedResult = yield* transaction.execute({
      label: "community.creation.verification.insert-result",
      text: `INSERT INTO community_creation_ceremony_results (
               ceremony_intent_id, actor_id, intent_id, requirement_kind,
               generation, requirement_hash, provider_id, provider_binding_hash,
               provider_configuration_version, callback_idempotency_key,
               callback_request_hash, outcome_status, result_hash, proof_session_id,
               evidence_receipt_id, evidence_ref, evidence_digest,
               provider_identity_digest, terminal_at, satisfied_at
             ) VALUES (
               $1, $2, $3, 'human_identity', $4, $5, $6, $7, $8, $9,
               $10, 'satisfied', $10, $11, $12, $12, $13, $14, $15, $15
             )`,
      values: [
        ceremonyIntentId,
        input.actor_id,
        intentId,
        generation,
        requirementHash,
        providerId,
        providerBindingHash,
        configurationVersion,
        session.completion_idempotency_key,
        input.result_hash,
        input.proof_session_id,
        evidence.evidenceReceiptId,
        evidence.evidenceDigest,
        evidence.subjectDigest,
        completedAt,
      ],
      readonly: false,
    });
    if (insertedResult.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const satisfied = yield* transaction.execute({
      label: "community.creation.verification.satisfy-human-requirement",
      text: `UPDATE community_creation_requirement_states
                SET status = 'satisfied', satisfied_at = $1, updated_at = clock_timestamp()
              WHERE intent_id = $2 AND actor_id = $3
                AND requirement_kind = 'human_identity'
                AND status = 'pending' AND generation = $4
                AND current_ceremony_intent_id = $5`,
      values: [completedAt, intentId, input.actor_id, generation, ceremonyIntentId],
      readonly: false,
    });
    if (satisfied.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());

    const requirementProgress = yield* reserveNextCreationRequirement(transaction, {
      actorId: input.actor_id,
      intentId,
      ceremonyIntentId: `community-creation-ceremony-${crypto.randomUUID()}`,
      operation: "get",
    }).pipe(Effect.mapError(() => verificationStorageFailure()));
    const nextStatus =
      requirementProgress === "complete" ? "commit_ready" : "verification_required";
    const nextRevision = document.revision + 1;
    const updated = yield* transaction.execute({
      label: "community.creation.verification.persist-intent",
      text: `UPDATE community_creation_intents
                SET revision = $1, status = $2, updated_at = clock_timestamp()
              WHERE intent_id = $3 AND actor_id = $4 AND revision = $5
                AND status = 'verification_required'
                AND expires_at > clock_timestamp()`,
      values: [nextRevision, nextStatus, intentId, input.actor_id, document.revision],
      readonly: false,
    });
    if (updated.rowCount === 0) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }
    if (updated.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const nextRow = yield* loadLockedIntent(transaction, input.actor_id, intentId, "get").pipe(
      Effect.mapError(() => verificationStorageFailure()),
    );
    const next = nextRow === null ? null : documentFromRow(nextRow);
    if (next === null) return yield* Effect.fail(verificationStorageFailure());
    yield* insertRevision(transaction, {
      intent: next,
      actorId: input.actor_id,
      operation: "verification",
      requestHash: input.result_hash,
    });
    return { kind: "advanced", intent_id: intentId, revision: next.revision } as const;
  });
}

export function advanceCommunityCreationNamespaceVerificationInTransaction(
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    readonly actor_id: string;
    readonly intent_id: string;
    readonly result_hash: string;
    readonly database_now: string;
  }>,
): Effect.Effect<
  CommunityCreationVerificationAdvanceOutcome,
  VerificationCompletionStorageFailed | ControlPlaneError
> {
  return Effect.gen(function* () {
    if (
      !validId(input.actor_id) ||
      !validId(input.intent_id) ||
      !SHA256_HEX.test(input.result_hash)
    ) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    const intentRow = yield* loadLockedIntent(
      transaction,
      input.actor_id,
      input.intent_id,
      "get",
      input.database_now,
    ).pipe(Effect.mapError(() => verificationStorageFailure()));
    if (intentRow === null) return { kind: "not_applicable" } as const;
    const document = documentFromRow(intentRow);
    if (document === null) return yield* Effect.fail(verificationStorageFailure());
    if (TERMINAL_STATUSES.has(document.status)) {
      return { kind: "stale", reason: "intent_terminal" } as const;
    }
    if (intentRow.expired === true) {
      return { kind: "stale", reason: "intent_expired" } as const;
    }
    if (document.status === "commit_ready") {
      return {
        kind: "already_ready",
        intent_id: document.intent_id,
        revision: document.revision,
      } as const;
    }
    if (document.status !== "verification_required") {
      return { kind: "stale", reason: "intent_not_verification_required" } as const;
    }

    const authorityResult = yield* transaction.execute<Row>({
      label: "community.creation.namespace-verification.lock-authority",
      text: `SELECT state.requirement_kind, state.status, state.generation,
                    state.current_ceremony_intent_id, state.satisfied_at,
                    result.outcome_status, result.result_hash,
                    result.satisfied_at AS result_satisfied_at
               FROM community_creation_requirement_states AS state
               JOIN community_creation_ceremony_results AS result
                 ON result.ceremony_intent_id = state.current_ceremony_intent_id
                AND result.actor_id = state.actor_id
                AND result.intent_id = state.intent_id
                AND result.requirement_kind = state.requirement_kind
                AND result.generation = state.generation
              WHERE state.intent_id = $1 AND state.actor_id = $2
              ORDER BY CASE state.requirement_kind
                WHEN 'human_identity' THEN 1
                WHEN 'namespace_ownership' THEN 2
              END
              FOR UPDATE OF state, result`,
      values: [input.intent_id, input.actor_id],
      readonly: false,
    });
    if (authorityResult.rows.length !== 2) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }
    const human = authorityResult.rows[0];
    const namespace = authorityResult.rows[1];
    const namespaceSatisfiedAt = asTimestamp(namespace?.satisfied_at);
    if (
      human?.requirement_kind !== "human_identity" ||
      namespace?.requirement_kind !== "namespace_ownership" ||
      human.status !== "satisfied" ||
      namespace.status !== "satisfied" ||
      human.outcome_status !== "satisfied" ||
      namespace.outcome_status !== "satisfied" ||
      asPositiveInteger(human.generation) === null ||
      asPositiveInteger(namespace.generation) === null ||
      asString(human.current_ceremony_intent_id) === null ||
      asString(namespace.current_ceremony_intent_id) === null ||
      asTimestamp(human.satisfied_at) !== asTimestamp(human.result_satisfied_at) ||
      namespaceSatisfiedAt === null ||
      namespaceSatisfiedAt !== asTimestamp(namespace.result_satisfied_at) ||
      namespace.result_hash !== input.result_hash
    ) {
      return { kind: "stale", reason: "session_binding_drift" } as const;
    }

    const nextRevision = document.revision + 1;
    const ready = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
      ...document,
      revision: nextRevision,
      status: "commit_ready",
      next_action: { kind: "commit" },
    });
    if (Option.isNone(ready)) return yield* Effect.fail(verificationStorageFailure());
    const updated = yield* transaction.execute({
      label: "community.creation.namespace-verification.persist-intent",
      text: `UPDATE community_creation_intents
                SET revision = $1, status = 'commit_ready', updated_at = $5::timestamptz
              WHERE intent_id = $2 AND actor_id = $3 AND revision = $4
                AND status = 'verification_required'
                AND creation_contract_version = 'route_v1'
                AND expires_at > $5::timestamptz`,
      values: [
        nextRevision,
        input.intent_id,
        input.actor_id,
        document.revision,
        input.database_now,
      ],
      readonly: false,
    });
    if (updated.rowCount !== 1) return yield* Effect.fail(verificationStorageFailure());
    const storedRow = yield* loadLockedIntent(
      transaction,
      input.actor_id,
      input.intent_id,
      "get",
      input.database_now,
    ).pipe(Effect.mapError(() => verificationStorageFailure()));
    const stored = storedRow === null ? null : documentFromRow(storedRow);
    if (stored === null || JSON.stringify(stored) !== JSON.stringify(ready.value)) {
      return yield* Effect.fail(verificationStorageFailure());
    }
    yield* insertRevision(transaction, {
      intent: stored,
      actorId: input.actor_id,
      operation: "verification",
      requestHash: input.result_hash,
    });
    return { kind: "advanced", intent_id: stored.intent_id, revision: stored.revision } as const;
  });
}

function exactCreateBody(value: unknown) {
  return Schema.decodeUnknownOption(CreateCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

function exactUpdateBody(value: unknown) {
  return Schema.decodeUnknownOption(UpdateCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

function exactCommitBody(value: unknown) {
  return Schema.decodeUnknownOption(CommitCommunityCreationIntent.request.body, {
    onExcessProperty: "error",
  })(value);
}

interface CommunityCreationRepository {
  readonly create: (
    input: Parameters<CommunityCreationStoreService["create"]>[0],
  ) => Effect.Effect<
    CreateCommunityCreationIntentResult,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly get: (
    input: Parameters<CommunityCreationStoreService["get"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument | null,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly update: (
    input: Parameters<CommunityCreationStoreService["update"]>[0],
  ) => Effect.Effect<
    CommunityCreationIntentDocument,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
  readonly commit: (
    input: Parameters<CommunityCreationStoreService["commit"]>[0],
  ) => Effect.Effect<
    CommitCommunityCreationIntentResult,
    CommunityCreationRepositoryFailure,
    ControlPlaneDb
  >;
}

export function makeControlPlaneCommunityCreationRepository(
  options: CommunityCreationRepositoryOptions = {},
): CommunityCreationRepository {
  const intentTtlSeconds = options.intent_ttl_seconds ?? COMMUNITY_CREATION_INTENT_TTL_SECONDS;
  const nextIntentId = options.next_intent_id ?? (() => `community-intent-${crypto.randomUUID()}`);
  const nextCommunityId = options.next_community_id ?? (() => `community-${crypto.randomUUID()}`);
  const nextRouteBindingId =
    options.next_route_binding_id ?? (() => `community-route-${crypto.randomUUID()}`);
  const nextSubjectClaimId =
    options.next_subject_claim_id ?? (() => `community-creation-claim-${crypto.randomUUID()}`);
  const nextCeremonyIntentId =
    options.next_ceremony_intent_id ?? (() => `community-creation-ceremony-${crypto.randomUUID()}`);
  const namespaceBindings = options.namespace_provider_bindings ?? [];
  const configured = Number.isSafeInteger(intentTtlSeconds) && intentTtlSeconds > 0;

  const create: CommunityCreationRepository["create"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactCreateBody(input.body);
      if (
        !configured ||
        !validId(input.actor.userId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("create", "constraint"));
      }
      const body = decodedBody.value;
      const intentId = nextIntentId();
      if (!validId(intentId)) return yield* Effect.fail(failure("create", "constraint"));
      const compiled = compileDraft(body.draft.policy, body.draft.route_request, namespaceBindings);
      if (compiled === null) return yield* Effect.fail(failure("create", "constraint"));
      const canonicalDraft = {
        ...body.draft,
        route_request: {
          family: compiled.route.family,
          root_label: compiled.route.root_label,
        },
      };
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "create");
          const replay = yield* replayByKey(transaction, {
            operation: "create",
            actorId: input.actor.userId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return { document: replay, outcome: "replayed" as const };

          const ceremonyIntentId = nextCeremonyIntentId();
          if (!validId(ceremonyIntentId)) {
            return yield* Effect.fail(failure("create", "constraint"));
          }
          const inserted = yield* transaction.execute({
            label: "community.creation.create.insert-intent",
            text: `INSERT INTO community_creation_intents (
                     intent_id, actor_id, create_idempotency_key, create_request_hash,
                     revision, status, draft, canonical_policy_revision,
                     canonical_policy_hash, verification_requirement_hash,
                     verification_provider_id, provider_configuration_kind,
                     provider_configuration_ref, provider_configuration_version,
                     expires_at, creation_contract_version
                   ) VALUES (
                     $1, $2, $3, $4, 1, $5, $6::jsonb, 1, $7, $8,
                     $9, $10, $11, $12,
                     clock_timestamp() + ($13::integer * interval '1 second'), 'route_v1'
                   )`,
            values: [
              intentId,
              input.actor.userId,
              body.idempotency_key,
              input.requestHash,
              compiled.status,
              JSON.stringify(canonicalDraft),
              compiled.canonicalPolicyHash,
              compiled.verificationRequirementHash,
              compiled.binding.providerId,
              compiled.binding.configurationKind,
              compiled.binding.configurationReference,
              compiled.binding.configurationVersion,
              intentTtlSeconds,
            ],
            readonly: false,
          });
          if (inserted.rowCount !== 1) {
            return yield* Effect.fail(failure("create", "invalid-row"));
          }
          yield* insertInitialCreationRequirements(transaction, {
            actorId: input.actor.userId,
            intentId,
            ceremonyIntentId,
            compiled,
          });
          const row = yield* loadLockedIntent(transaction, input.actor.userId, intentId, "create");
          if (row === null) return yield* Effect.fail(failure("create", "invalid-row"));
          const document = documentFromRow(row);
          if (document === null) return yield* Effect.fail(failure("create", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: document,
            actorId: input.actor.userId,
            operation: "create",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return { document, outcome: "fresh" as const };
        }),
      );
    });

  const get: CommunityCreationRepository["get"] = (input) =>
    Effect.gen(function* () {
      if (!validId(input.actor.userId) || !validId(input.intentId)) {
        return yield* Effect.fail(failure("get", "not-found"));
      }
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "get",
          );
          if (row === null) return null;
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("get", "invalid-row"));
          }
          if (row.expired !== true || TERMINAL_STATUSES.has(document.status)) return document;
          const transitioned = transitionCommunityCreationIntent(
            stateFromDocument(document, providerId),
            { type: "expired", expected_revision: document.revision },
          );
          if (transitioned.kind === "rejected") {
            return yield* Effect.fail(failure("get", "invalid-row"));
          }
          const expired = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
            ...document,
            revision: transitioned.state.revision,
            status: transitioned.state.status,
            next_action: creationNextAction(transitioned.state),
          });
          if (Option.isNone(expired)) return yield* Effect.fail(failure("get", "invalid-row"));
          const updated = yield* transaction.execute({
            label: "community.creation.get.expire-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = 'expired', updated_at = clock_timestamp()
                    WHERE intent_id = $2 AND actor_id = $3 AND revision = $4`,
            values: [expired.value.revision, input.intentId, input.actor.userId, document.revision],
            readonly: false,
          });
          if (updated.rowCount !== 1) return yield* Effect.fail(failure("get", "invalid-row"));
          const requestHash = asString(row.create_request_hash);
          if (requestHash === null) return yield* Effect.fail(failure("get", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: expired.value,
            actorId: input.actor.userId,
            operation: "expire",
            requestHash,
          });
          return expired.value;
        }),
      );
    });

  const update: CommunityCreationRepository["update"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactUpdateBody(input.body);
      if (
        !validId(input.actor.userId) ||
        !validId(input.intentId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("update", "constraint"));
      }
      const body = decodedBody.value;
      const compiled = compileDraft(body.draft.policy, body.draft.route_request, namespaceBindings);
      if (compiled === null) return yield* Effect.fail(failure("update", "constraint"));
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "update");
          const replay = yield* replayByKey(transaction, {
            operation: "update",
            actorId: input.actor.userId,
            intentId: input.intentId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return replay;
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "update",
          );
          if (row === null) return yield* Effect.fail(failure("update", "not-found"));
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("update", "invalid-row"));
          }
          if (row.expired === true || TERMINAL_STATUSES.has(document.status)) {
            return yield* Effect.fail(failure("update", "constraint"));
          }
          if (body.expected_revision !== document.revision) {
            return yield* Effect.fail(failure("update", "revision-conflict"));
          }
          yield* replaceCreationRequirementBindings(transaction, {
            actorId: input.actor.userId,
            intentId: input.intentId,
            compiled,
          });
          const ceremonyIntentId = nextCeremonyIntentId();
          if (!validId(ceremonyIntentId)) {
            return yield* Effect.fail(failure("update", "constraint"));
          }
          const selection =
            compiled.status === "gate_unsupported"
              ? "pending"
              : yield* reserveNextCreationRequirement(transaction, {
                  actorId: input.actor.userId,
                  intentId: input.intentId,
                  ceremonyIntentId,
                  operation: "update",
                });
          const nextStatus =
            compiled.status === "gate_unsupported"
              ? "gate_unsupported"
              : selection === "complete"
                ? "commit_ready"
                : "verification_required";
          const canonicalDraft = {
            ...body.draft,
            route_request: {
              family: compiled.route.family,
              root_label: compiled.route.root_label,
            },
          };
          const updated = yield* transaction.execute({
            label: "community.creation.update.persist-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = $2, draft = $3::jsonb,
                          canonical_policy_revision = $4, canonical_policy_hash = $5,
                          verification_requirement_hash = $6,
                          verification_provider_id = $7,
                          provider_configuration_kind = $8,
                          provider_configuration_ref = $9,
                          provider_configuration_version = $10,
                          updated_at = clock_timestamp()
                    WHERE intent_id = $11 AND actor_id = $12 AND revision = $13`,
            values: [
              document.revision + 1,
              nextStatus,
              JSON.stringify(canonicalDraft),
              document.canonical_policy_revision + 1,
              compiled.canonicalPolicyHash,
              compiled.verificationRequirementHash,
              compiled.binding.providerId,
              compiled.binding.configurationKind,
              compiled.binding.configurationReference,
              compiled.binding.configurationVersion,
              input.intentId,
              input.actor.userId,
              document.revision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1) return yield* Effect.fail(failure("update", "invalid-row"));
          const storedRow = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "update",
          );
          if (storedRow === null) return yield* Effect.fail(failure("update", "invalid-row"));
          const stored = documentFromRow(storedRow);
          if (stored === null) return yield* Effect.fail(failure("update", "invalid-row"));
          yield* insertRevision(transaction, {
            intent: stored,
            actorId: input.actor.userId,
            operation: "update",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return stored;
        }),
      );
    });

  const commit: CommunityCreationRepository["commit"] = (input) =>
    Effect.gen(function* () {
      const decodedBody = exactCommitBody(input.body);
      if (
        !validId(input.actor.userId) ||
        !validId(input.intentId) ||
        !SHA256_HEX.test(input.requestHash) ||
        Option.isNone(decodedBody)
      ) {
        return yield* Effect.fail(failure("commit", "constraint"));
      }
      const body = decodedBody.value;
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* lockActor(transaction, input.actor.userId, "commit");
          const replay = yield* replayByKey(transaction, {
            operation: "commit",
            actorId: input.actor.userId,
            intentId: input.intentId,
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          if (replay !== null) return { document: replay, outcome: "replayed" as const };
          const row = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "commit",
          );
          if (row === null) return yield* Effect.fail(failure("commit", "not-found"));
          const document = documentFromRow(row);
          const providerId = asString(row.verification_provider_id);
          if (document === null || providerId === null) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (body.expected_revision !== document.revision) {
            return yield* Effect.fail(failure("commit", "revision-conflict"));
          }
          if (
            row.expired === true ||
            document.status !== "commit_ready" ||
            TERMINAL_STATUSES.has(document.status)
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const compilation = compileCommunityGatePolicy(document.draft.policy);
          const compiledDraft = compileDraft(
            document.draft.policy,
            document.draft.route_request,
            namespaceBindings,
          );
          if (
            compilation.kind !== "supported" ||
            compiledDraft === null ||
            compiledDraft.status !== "verification_required" ||
            compilation.canonical_policy_hash !== document.canonical_policy_hash ||
            compilation.verification_requirement_hash !==
              document.requirements.human_identity.requirement_hash ||
            compiledDraft.namespaceRequirementHash !==
              document.requirements.namespace_ownership.requirement_hash ||
            providerId !== compilation.provider_binding.provider_id ||
            row.provider_configuration_kind !==
              compilation.provider_binding.provider_configuration.kind ||
            row.provider_configuration_ref !==
              compilation.provider_binding.provider_configuration.reference ||
            row.provider_configuration_version !==
              compilation.provider_binding.provider_configuration.version
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const clockResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.database-clock",
            text: "SELECT clock_timestamp() AS database_now",
            values: [],
            readonly: false,
          });
          const clockRow = oneRow(clockResult.rows);
          if (clockRow === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          const databaseNow = clockRow === null ? null : asTimestamp(clockRow.database_now);
          if (databaseNow === null) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }

          const requirementResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-requirements",
            text: `SELECT requirement_kind, status, requirement_hash, provider_id,
                          provider_binding_hash, provider_configuration_kind,
                          provider_configuration_ref, provider_configuration_version,
                          route_family, route_root_label, route_root_label_display,
                          route_path_segment, generation, current_ceremony_intent_id,
                          satisfied_at
                     FROM community_creation_requirement_states
                    WHERE actor_id = $1 AND intent_id = $2
                    ORDER BY CASE requirement_kind
                      WHEN 'human_identity' THEN 1
                      WHEN 'namespace_ownership' THEN 2
                    END
                    FOR UPDATE`,
            values: [input.actor.userId, input.intentId],
            readonly: false,
          });
          if (requirementResult.rows.length !== 2) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          const humanState = requirementResult.rows[0];
          const namespaceState = requirementResult.rows[1];
          const humanGeneration = asPositiveInteger(humanState?.generation);
          const namespaceGeneration = asPositiveInteger(namespaceState?.generation);
          const humanCeremonyId = asString(humanState?.current_ceremony_intent_id);
          const namespaceCeremonyId = asString(namespaceState?.current_ceremony_intent_id);
          const humanSatisfiedAt = asTimestamp(humanState?.satisfied_at);
          const namespaceSatisfiedAt = asTimestamp(namespaceState?.satisfied_at);
          if (
            humanState?.requirement_kind !== "human_identity" ||
            namespaceState?.requirement_kind !== "namespace_ownership" ||
            humanState.status !== "satisfied" ||
            namespaceState.status !== "satisfied" ||
            humanGeneration === null ||
            namespaceGeneration === null ||
            humanCeremonyId === null ||
            namespaceCeremonyId === null ||
            humanSatisfiedAt === null ||
            namespaceSatisfiedAt === null ||
            Date.parse(humanSatisfiedAt) > Date.parse(databaseNow) ||
            Date.parse(namespaceSatisfiedAt) > Date.parse(databaseNow) ||
            humanState.requirement_hash !== compiledDraft.verificationRequirementHash ||
            humanState.provider_id !== compiledDraft.binding.providerId ||
            humanState.provider_binding_hash !== compiledDraft.humanProviderBindingHash ||
            humanState.provider_configuration_kind !== compiledDraft.binding.configurationKind ||
            humanState.provider_configuration_ref !==
              compiledDraft.binding.configurationReference ||
            humanState.provider_configuration_version !==
              compiledDraft.binding.configurationVersion ||
            humanState.route_family !== null ||
            humanState.route_root_label !== null ||
            humanState.route_root_label_display !== null ||
            humanState.route_path_segment !== null ||
            namespaceState.requirement_hash !== compiledDraft.namespaceRequirementHash ||
            namespaceState.provider_id !== compiledDraft.namespaceBinding.providerId ||
            namespaceState.provider_binding_hash !==
              compiledDraft.namespaceBinding.providerBindingHash ||
            namespaceState.provider_configuration_kind !==
              compiledDraft.namespaceBinding.configurationKind ||
            namespaceState.provider_configuration_ref !==
              compiledDraft.namespaceBinding.configurationReference ||
            namespaceState.provider_configuration_version !==
              compiledDraft.namespaceBinding.configurationVersion ||
            namespaceState.route_family !== compiledDraft.route.family ||
            namespaceState.route_root_label !== compiledDraft.route.root_label ||
            namespaceState.route_root_label_display !== compiledDraft.route.root_label_display ||
            namespaceState.route_path_segment !== compiledDraft.route.path_segment
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const humanResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-human-result",
            text: `SELECT attempt.ceremony_intent_id, attempt.actor_id, attempt.intent_id,
                          attempt.requirement_kind, attempt.generation,
                          attempt.requirement_hash, attempt.provider_id,
                          attempt.provider_binding_hash,
                          attempt.provider_configuration_kind,
                          attempt.provider_configuration_ref,
                          attempt.provider_configuration_version,
                          result.outcome_status, result.proof_session_id,
                          result.evidence_receipt_id, result.evidence_ref,
                          result.evidence_digest, result.provider_identity_digest,
                          result.terminal_at AS result_terminal_at,
                          result.satisfied_at AS result_satisfied_at,
                          proof.provider_id AS proof_provider_id,
                          proof.provider_configuration_kind AS proof_configuration_kind,
                          proof.provider_configuration_ref AS proof_configuration_ref,
                          proof.provider_configuration_version AS proof_configuration_version,
                          proof.method, proof.issuer, proof.scope_kind,
                          proof.issuer_rp_scope, proof.issuer_rp_action_scope,
                          proof.request_mode, proof.requested_requirements,
                          proof.requested_claim_ids, proof.subject_binding_intent,
                          proof.protocol_version, proof.environment, proof.status AS proof_status,
                          proof.expires_at AS proof_expires_at,
                          proof.completed_at AS proof_completed_at,
                          proof.terminal_at AS proof_terminal_at,
                          proof.completion_idempotency_key,
                          proof.completion_result_hash,
                          proof.creation_ceremony_intent_id
                     FROM community_creation_ceremony_attempts AS attempt
                     JOIN community_creation_ceremony_results AS result
                       ON result.ceremony_intent_id = attempt.ceremony_intent_id
                     JOIN proof_sessions AS proof
                       ON proof.proof_session_id = result.proof_session_id
                    WHERE attempt.actor_id = $1 AND attempt.intent_id = $2
                      AND attempt.requirement_kind = 'human_identity'
                      AND attempt.generation = $3
                      AND attempt.ceremony_intent_id = $4
                    FOR UPDATE OF attempt, result, proof`,
            values: [input.actor.userId, input.intentId, humanGeneration, humanCeremonyId],
            readonly: false,
          });
          const session = oneRow(humanResult.rows);
          if (session === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (session === null) return yield* Effect.fail(failure("commit", "constraint"));
          const proofSessionId = asString(session.proof_session_id);
          const completedAt = asTimestamp(session.proof_completed_at);
          const terminalAt = asTimestamp(session.proof_terminal_at);
          const sessionExpiresAt = asTimestamp(session.proof_expires_at);
          const resultTerminalAt = asTimestamp(session.result_terminal_at);
          const resultSatisfiedAt = asTimestamp(session.result_satisfied_at);
          if (
            proofSessionId === null ||
            session.actor_id !== input.actor.userId ||
            session.intent_id !== input.intentId ||
            session.requirement_kind !== "human_identity" ||
            session.generation !== humanState.generation ||
            session.ceremony_intent_id !== humanCeremonyId ||
            session.requirement_hash !== humanState.requirement_hash ||
            session.provider_id !== humanState.provider_id ||
            session.provider_binding_hash !== humanState.provider_binding_hash ||
            session.provider_configuration_kind !== humanState.provider_configuration_kind ||
            session.provider_configuration_ref !== humanState.provider_configuration_ref ||
            session.provider_configuration_version !== humanState.provider_configuration_version ||
            session.outcome_status !== "satisfied" ||
            session.creation_ceremony_intent_id !== humanCeremonyId ||
            session.proof_status !== "completed" ||
            asString(session.completion_idempotency_key) === null ||
            !SHA256_HEX.test(asString(session.completion_result_hash) ?? "") ||
            completedAt === null ||
            terminalAt === null ||
            sessionExpiresAt === null ||
            resultTerminalAt === null ||
            resultSatisfiedAt === null ||
            completedAt !== terminalAt ||
            resultTerminalAt !== resultSatisfiedAt ||
            resultSatisfiedAt !== humanSatisfiedAt ||
            Date.parse(completedAt) >= Date.parse(sessionExpiresAt) ||
            Date.parse(resultSatisfiedAt) > Date.parse(databaseNow) ||
            session.proof_provider_id !== compilation.provider_binding.provider_id ||
            session.proof_configuration_kind !==
              compilation.provider_binding.provider_configuration.kind ||
            session.proof_configuration_ref !==
              compilation.provider_binding.provider_configuration.reference ||
            session.proof_configuration_version !==
              compilation.provider_binding.provider_configuration.version ||
            session.method !== compilation.provider_binding.method ||
            session.issuer !== compilation.provider_binding.scope.issuer ||
            session.scope_kind !== compilation.provider_binding.scope.scope_semantics ||
            session.issuer_rp_scope !== compilation.provider_binding.scope.rp_scope ||
            session.issuer_rp_action_scope !== null ||
            session.request_mode !== "dynamic" ||
            !exactCanonicalJson(session.requested_requirements, HUMAN_MEMBERSHIP_REQUIREMENTS) ||
            !exactCanonicalJson(session.requested_claim_ids, HUMAN_MEMBERSHIP_CLAIM_IDS) ||
            session.subject_binding_intent !== "establish" ||
            session.protocol_version !== compilation.provider_binding.protocol_version ||
            asString(session.environment) === null
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const evidence = yield* loadCommitEvidence(transaction, {
            actorId: input.actor.userId,
            proofSessionId,
          });
          if (evidence === null) return yield* Effect.fail(failure("commit", "constraint"));
          if (
            session.evidence_receipt_id !== evidence.evidenceReceiptId ||
            session.evidence_ref !== evidence.evidenceReceiptId ||
            session.evidence_digest !== evidence.evidenceDigest ||
            session.provider_identity_digest !== evidence.subjectDigest
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const namespaceResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-namespace-result",
            text: `SELECT attempt.ceremony_intent_id, attempt.actor_id, attempt.intent_id,
                          attempt.requirement_kind, attempt.generation,
                          attempt.requirement_hash, attempt.provider_id,
                          attempt.provider_binding_hash,
                          attempt.provider_configuration_kind,
                          attempt.provider_configuration_ref,
                          attempt.provider_configuration_version,
                          attempt.route_family, attempt.route_root_label,
                          attempt.route_root_label_display, attempt.route_path_segment,
                          result.outcome_status, result.namespace_session_id,
                          result.completion_attempt_id, result.submission_channel,
                          result.evidence_receipt_id AS result_evidence_receipt_id,
                          result.evidence_ref, result.evidence_digest,
                          result.provider_identity_digest,
                          result.terminal_at AS result_terminal_at,
                          result.satisfied_at AS result_satisfied_at,
                          namespace_session.status AS session_status,
                          namespace_session.completed_at AS session_completed_at,
                          namespace_session.terminal_at AS session_terminal_at,
                          namespace_session.expires_at AS session_expires_at,
                          namespace_session.upstream_session_ref,
                          namespace_session.protocol_version AS namespace_protocol_version,
                          namespace_session.environment AS namespace_environment,
                          completion.state AS completion_state,
                          completion.consumption_kind,
                          completion.fence_token AS completion_fence_token,
                          snapshot.evidence_ref AS snapshot_evidence_ref,
                          snapshot.completion_attempt_id AS snapshot_completion_attempt_id,
                          snapshot.namespace_session_id AS snapshot_namespace_session_id,
                          snapshot.actor_id AS snapshot_actor_id,
                          snapshot.creation_intent_id AS snapshot_intent_id,
                          snapshot.ceremony_intent_id AS snapshot_ceremony_intent_id,
                          snapshot.generation AS snapshot_generation,
                          snapshot.requirement_hash AS snapshot_requirement_hash,
                          snapshot.provider_id AS snapshot_provider_id,
                          snapshot.provider_binding_hash AS snapshot_provider_binding_hash,
                          snapshot.provider_configuration_kind AS snapshot_configuration_kind,
                          snapshot.provider_configuration_ref AS snapshot_configuration_ref,
                          snapshot.provider_configuration_version AS snapshot_configuration_version,
                          snapshot.protocol_version AS snapshot_protocol_version,
                          snapshot.environment AS snapshot_environment,
                          snapshot.family AS snapshot_family,
                          snapshot.root_label AS snapshot_root_label,
                          snapshot.root_label_display AS snapshot_root_label_display,
                          snapshot.path_segment AS snapshot_path_segment,
                          snapshot.href AS snapshot_href,
                          snapshot.upstream_session_ref AS snapshot_upstream_session_ref,
                          snapshot.fence_token AS snapshot_fence_token,
                          snapshot.observed_at,
                          snapshot.expires_at AS snapshot_expires_at,
                          snapshot.provider_identity_digest AS snapshot_provider_identity_digest,
                          snapshot.evidence_digest AS snapshot_evidence_digest,
                          snapshot.raw_response_bytes, snapshot.observation,
                          evidence.creation_ceremony_intent_id AS evidence_ceremony_intent_id,
                          evidence.verified_by_actor_id, evidence.family,
                          evidence.root_label, evidence.root_label_display,
                          evidence.path_segment, evidence.requirement_hash AS evidence_requirement_hash,
                          evidence.provider_id AS evidence_provider_id,
                          evidence.provider_binding_hash AS evidence_provider_binding_hash,
                          evidence.provider_configuration_version AS evidence_configuration_version,
                          evidence.provider_identity_digest AS route_provider_identity_digest,
                          evidence.evidence_digest AS route_evidence_digest,
                          evidence.evidence_receipt_id AS route_evidence_receipt_id,
                          evidence.binding_generation, evidence.verified_at,
                          evidence.expires_at AS route_evidence_expires_at
                     FROM community_creation_ceremony_attempts AS attempt
                     JOIN community_creation_ceremony_results AS result
                       ON result.ceremony_intent_id = attempt.ceremony_intent_id
                     JOIN namespace_ownership_sessions AS namespace_session
                       ON namespace_session.namespace_session_id = result.namespace_session_id
                     JOIN namespace_ownership_completion_attempts AS completion
                       ON completion.completion_attempt_id = result.completion_attempt_id
                     JOIN namespace_ownership_evidence_snapshots AS snapshot
                       ON snapshot.evidence_ref = result.evidence_ref
                      AND snapshot.completion_attempt_id = completion.completion_attempt_id
                     JOIN community_route_ownership_evidence AS evidence
                       ON evidence.evidence_ref = result.evidence_ref
                    WHERE attempt.actor_id = $1 AND attempt.intent_id = $2
                      AND attempt.requirement_kind = 'namespace_ownership'
                      AND attempt.generation = $3
                      AND attempt.ceremony_intent_id = $4
                    FOR UPDATE OF attempt, result, namespace_session, completion, snapshot, evidence`,
            values: [input.actor.userId, input.intentId, namespaceGeneration, namespaceCeremonyId],
            readonly: false,
          });
          const namespaceAuthority = oneRow(namespaceResult.rows);
          const namespaceTerminalAt = asTimestamp(namespaceAuthority?.result_terminal_at);
          const namespaceResultSatisfiedAt = asTimestamp(namespaceAuthority?.result_satisfied_at);
          const namespaceSessionCompletedAt = asTimestamp(namespaceAuthority?.session_completed_at);
          const namespaceSessionTerminalAt = asTimestamp(namespaceAuthority?.session_terminal_at);
          const namespaceSessionExpiresAt = asTimestamp(namespaceAuthority?.session_expires_at);
          const snapshotObservedAt = asTimestamp(namespaceAuthority?.observed_at);
          const snapshotExpiresAt = asTimestamp(namespaceAuthority?.snapshot_expires_at);
          const routeEvidenceVerifiedAt = asTimestamp(namespaceAuthority?.verified_at);
          const routeEvidenceExpiresAt =
            namespaceAuthority?.route_evidence_expires_at === null
              ? null
              : asTimestamp(namespaceAuthority?.route_evidence_expires_at);
          const observation = jsonValue(namespaceAuthority?.observation);
          if (
            namespaceAuthority === undefined ||
            namespaceAuthority === null ||
            namespaceAuthority.actor_id !== input.actor.userId ||
            namespaceAuthority.intent_id !== input.intentId ||
            namespaceAuthority.requirement_kind !== "namespace_ownership" ||
            namespaceAuthority.generation !== namespaceState.generation ||
            namespaceAuthority.ceremony_intent_id !== namespaceCeremonyId ||
            namespaceAuthority.requirement_hash !== namespaceState.requirement_hash ||
            namespaceAuthority.provider_id !== namespaceState.provider_id ||
            namespaceAuthority.provider_binding_hash !== namespaceState.provider_binding_hash ||
            namespaceAuthority.provider_configuration_kind !==
              namespaceState.provider_configuration_kind ||
            namespaceAuthority.provider_configuration_ref !==
              namespaceState.provider_configuration_ref ||
            namespaceAuthority.provider_configuration_version !==
              namespaceState.provider_configuration_version ||
            namespaceAuthority.route_family !== compiledDraft.route.family ||
            namespaceAuthority.route_root_label !== compiledDraft.route.root_label ||
            namespaceAuthority.route_root_label_display !==
              compiledDraft.route.root_label_display ||
            namespaceAuthority.route_path_segment !== compiledDraft.route.path_segment ||
            namespaceAuthority.outcome_status !== "satisfied" ||
            asString(namespaceAuthority.namespace_session_id) === null ||
            asString(namespaceAuthority.completion_attempt_id) === null ||
            namespaceAuthority.submission_channel !== "poll_result" ||
            namespaceAuthority.result_evidence_receipt_id !== null ||
            asString(namespaceAuthority.evidence_ref) === null ||
            !SHA256_HEX.test(asString(namespaceAuthority.evidence_digest) ?? "") ||
            !SHA256_HEX.test(asString(namespaceAuthority.provider_identity_digest) ?? "") ||
            namespaceAuthority.snapshot_evidence_ref !== namespaceAuthority.evidence_ref ||
            namespaceAuthority.snapshot_completion_attempt_id !==
              namespaceAuthority.completion_attempt_id ||
            namespaceAuthority.snapshot_namespace_session_id !==
              namespaceAuthority.namespace_session_id ||
            namespaceAuthority.snapshot_actor_id !== input.actor.userId ||
            namespaceAuthority.snapshot_intent_id !== input.intentId ||
            namespaceAuthority.snapshot_ceremony_intent_id !== namespaceCeremonyId ||
            namespaceAuthority.snapshot_generation !== namespaceState.generation ||
            namespaceAuthority.snapshot_requirement_hash !== namespaceState.requirement_hash ||
            namespaceAuthority.snapshot_provider_id !== namespaceState.provider_id ||
            namespaceAuthority.snapshot_provider_binding_hash !==
              namespaceState.provider_binding_hash ||
            namespaceAuthority.snapshot_configuration_kind !==
              namespaceState.provider_configuration_kind ||
            namespaceAuthority.snapshot_configuration_ref !==
              namespaceState.provider_configuration_ref ||
            namespaceAuthority.snapshot_configuration_version !==
              namespaceState.provider_configuration_version ||
            namespaceAuthority.snapshot_protocol_version !==
              namespaceAuthority.namespace_protocol_version ||
            namespaceAuthority.snapshot_environment !== namespaceAuthority.namespace_environment ||
            namespaceAuthority.snapshot_family !== compiledDraft.route.family ||
            namespaceAuthority.snapshot_root_label !== compiledDraft.route.root_label ||
            namespaceAuthority.snapshot_root_label_display !==
              compiledDraft.route.root_label_display ||
            namespaceAuthority.snapshot_path_segment !== compiledDraft.route.path_segment ||
            namespaceAuthority.snapshot_href !== compiledDraft.route.href ||
            namespaceAuthority.snapshot_upstream_session_ref !==
              namespaceAuthority.upstream_session_ref ||
            namespaceAuthority.snapshot_fence_token !== namespaceAuthority.completion_fence_token ||
            namespaceAuthority.snapshot_evidence_digest !== namespaceAuthority.evidence_digest ||
            namespaceAuthority.snapshot_provider_identity_digest !==
              namespaceAuthority.provider_identity_digest ||
            namespaceTerminalAt === null ||
            namespaceResultSatisfiedAt === null ||
            namespaceTerminalAt !== namespaceResultSatisfiedAt ||
            namespaceResultSatisfiedAt !== namespaceSatisfiedAt ||
            namespaceAuthority.session_status !== "completed" ||
            namespaceSessionCompletedAt === null ||
            namespaceSessionTerminalAt === null ||
            namespaceSessionExpiresAt === null ||
            namespaceSessionCompletedAt !== namespaceSessionTerminalAt ||
            namespaceSessionTerminalAt !== namespaceResultSatisfiedAt ||
            Date.parse(namespaceSessionTerminalAt) >= Date.parse(namespaceSessionExpiresAt) ||
            namespaceAuthority.completion_state !== "consumed" ||
            namespaceAuthority.consumption_kind !== "verified" ||
            snapshotObservedAt === null ||
            snapshotExpiresAt === null ||
            Date.parse(snapshotObservedAt) > Date.parse(databaseNow) ||
            Date.parse(snapshotExpiresAt) <= Date.parse(databaseNow) ||
            !(namespaceAuthority.raw_response_bytes instanceof Uint8Array) ||
            namespaceAuthority.raw_response_bytes.byteLength === 0 ||
            observation === null ||
            typeof observation !== "object" ||
            Array.isArray(observation) ||
            (observation as Row).status !== "verified" ||
            namespaceAuthority.evidence_ceremony_intent_id !== namespaceCeremonyId ||
            namespaceAuthority.verified_by_actor_id !== input.actor.userId ||
            namespaceAuthority.family !== compiledDraft.route.family ||
            namespaceAuthority.root_label !== compiledDraft.route.root_label ||
            namespaceAuthority.root_label_display !== compiledDraft.route.root_label_display ||
            namespaceAuthority.path_segment !== compiledDraft.route.path_segment ||
            namespaceAuthority.evidence_requirement_hash !== namespaceState.requirement_hash ||
            namespaceAuthority.evidence_provider_id !== namespaceState.provider_id ||
            namespaceAuthority.evidence_provider_binding_hash !==
              namespaceState.provider_binding_hash ||
            namespaceAuthority.evidence_configuration_version !==
              namespaceState.provider_configuration_version ||
            namespaceAuthority.route_provider_identity_digest !==
              namespaceAuthority.provider_identity_digest ||
            namespaceAuthority.route_evidence_digest !== namespaceAuthority.evidence_digest ||
            namespaceAuthority.route_evidence_receipt_id !==
              namespaceAuthority.result_evidence_receipt_id ||
            namespaceAuthority.binding_generation !== namespaceState.generation ||
            routeEvidenceVerifiedAt === null ||
            routeEvidenceVerifiedAt !== namespaceResultSatisfiedAt ||
            (routeEvidenceExpiresAt !== null &&
              Date.parse(routeEvidenceExpiresAt) <= Date.parse(databaseNow))
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          yield* transaction.execute({
            label: "community.creation.commit.lock-canonical-route",
            text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 19012027))",
            values: [compiledDraft.route.path_segment],
            readonly: false,
          });
          const routeResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.check-canonical-route",
            text: `SELECT route_binding_id
                     FROM community_canonical_route_bindings
                    WHERE path_segment = $1
                    FOR UPDATE`,
            values: [compiledDraft.route.path_segment],
            readonly: false,
          });
          const existingRoute = oneRow(routeResult.rows);
          if (existingRoute === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (existingRoute !== null) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const subjectResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-subject",
            text: `SELECT subject_key_id, issuer, method, scope_kind,
                          issuer_rp_scope, issuer_rp_action_scope,
                          subject_digest, digest_algorithm
                     FROM subject_keys
                    WHERE subject_key_id = $1
                    FOR UPDATE`,
            values: [evidence.subjectKeyId],
            readonly: false,
          });
          const subject = oneRow(subjectResult.rows);
          if (subject === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          if (
            subject === null ||
            subject.subject_key_id !== evidence.subjectKeyId ||
            subject.issuer !== compilation.provider_binding.scope.issuer ||
            subject.method !== compilation.provider_binding.method ||
            subject.scope_kind !== compilation.provider_binding.scope.scope_semantics ||
            subject.issuer_rp_scope !== compilation.provider_binding.scope.rp_scope ||
            subject.issuer_rp_action_scope !== null ||
            !SHA256_HEX.test(asString(subject.subject_digest) ?? "") ||
            subject.digest_algorithm !== "sha256"
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const slotOneResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.lock-slot-one",
            text: `SELECT claim_id
                     FROM community_creation_subject_claims
                    WHERE subject_key_id = $1 AND slot_number = 1
                    FOR UPDATE`,
            values: [evidence.subjectKeyId],
            readonly: false,
          });
          const slotOne = oneRow(slotOneResult.rows);
          if (slotOne === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }

          let slotNumber = 1;
          let approvalId: string | null = null;
          let approvalExpiresAt: string | null = null;
          if (slotOne !== null) {
            const approvalResult = yield* transaction.execute<Row>({
              label: "community.creation.commit.lock-approval",
              text: `SELECT approval.approval_id, approval.slot_number, approval.expires_at
                       FROM community_creation_quota_approvals AS approval
                      WHERE approval.subject_key_id = $1
                        AND approval.actor_id = $2
                        AND approval.expires_at > clock_timestamp()
                        AND NOT EXISTS (
                          SELECT 1
                            FROM community_creation_subject_claims AS claim
                           WHERE claim.approval_id = approval.approval_id
                              OR (
                                claim.subject_key_id = approval.subject_key_id
                                AND claim.slot_number = approval.slot_number
                              )
                        )
                      ORDER BY approval.slot_number, approval.approval_id
                      FOR UPDATE OF approval
                      LIMIT 1`,
              values: [evidence.subjectKeyId, input.actor.userId],
              readonly: false,
            });
            const approval = oneRow(approvalResult.rows);
            if (approval === undefined) {
              return yield* Effect.fail(failure("commit", "invalid-row"));
            }
            if (approval === null) {
              const transitioned = transitionCommunityCreationIntent(
                stateFromDocument(document, providerId),
                { type: "commit_quota_exceeded", expected_revision: document.revision },
              );
              if (transitioned.kind === "rejected") {
                return yield* Effect.fail(failure("commit", "constraint"));
              }
              const quotaExceeded = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
                ...document,
                revision: transitioned.state.revision,
                status: transitioned.state.status,
                next_action: creationNextAction(transitioned.state),
              });
              if (Option.isNone(quotaExceeded)) {
                return yield* Effect.fail(failure("commit", "invalid-row"));
              }
              const updated = yield* transaction.execute({
                label: "community.creation.commit.persist-quota-exceeded",
                text: `UPDATE community_creation_intents
                          SET revision = $1, status = 'quota_exceeded',
                              updated_at = clock_timestamp()
                        WHERE intent_id = $2 AND actor_id = $3 AND revision = $4
                          AND status = 'commit_ready'
                          AND expires_at > clock_timestamp()`,
                values: [
                  quotaExceeded.value.revision,
                  input.intentId,
                  input.actor.userId,
                  document.revision,
                ],
                readonly: false,
              });
              if (updated.rowCount !== 1) {
                return yield* Effect.fail(failure("commit", "invalid-row"));
              }
              yield* insertRevision(transaction, {
                intent: quotaExceeded.value,
                actorId: input.actor.userId,
                operation: "commit",
                idempotencyKey: body.idempotency_key,
                requestHash: input.requestHash,
              });
              return {
                document: quotaExceeded.value,
                outcome: "fresh_not_created" as const,
              };
            }
            approvalId = asString(approval.approval_id);
            const approvedSlot = asPositiveInteger(approval.slot_number);
            approvalExpiresAt = asTimestamp(approval.expires_at);
            if (
              approvalId === null ||
              approvedSlot === null ||
              approvedSlot <= 1 ||
              approvalExpiresAt === null
            ) {
              return yield* Effect.fail(failure("commit", "invalid-row"));
            }
            slotNumber = approvedSlot;
          }

          const activationClockResult = yield* transaction.execute<Row>({
            label: "community.creation.commit.activation-clock",
            text: "SELECT clock_timestamp() AS activation_now",
            values: [],
            readonly: false,
          });
          const activationClockRow = oneRow(activationClockResult.rows);
          if (activationClockRow === undefined) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          const activationNow =
            activationClockRow === null ? null : asTimestamp(activationClockRow.activation_now);
          if (
            activationNow === null ||
            Date.parse(document.expires_at) <= Date.parse(activationNow) ||
            snapshotExpiresAt === null ||
            Date.parse(snapshotExpiresAt) <= Date.parse(activationNow) ||
            (routeEvidenceExpiresAt !== null &&
              Date.parse(routeEvidenceExpiresAt) <= Date.parse(activationNow)) ||
            (evidence.receiptExpiresAt !== null &&
              Date.parse(evidence.receiptExpiresAt) <= Date.parse(activationNow)) ||
            (evidence.assertionExpiresAt !== null &&
              Date.parse(evidence.assertionExpiresAt) <= Date.parse(activationNow)) ||
            (approvalExpiresAt !== null &&
              Date.parse(approvalExpiresAt) <= Date.parse(activationNow))
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }

          const communityId = nextCommunityId();
          const routeBindingId = nextRouteBindingId();
          const subjectClaimId = nextSubjectClaimId();
          if (!validId(communityId) || !validId(routeBindingId) || !validId(subjectClaimId)) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }
          const resource = {
            community_id: communityId,
            href: compiledDraft.route.href,
            canonical_route: canonicalRouteView(compiledDraft.route, false),
          } as const;
          const transitioned = transitionCommunityCreationIntent(
            stateFromDocument(document, providerId),
            {
              type: "commit_completed",
              expected_revision: document.revision,
              resource,
            },
          );
          if (transitioned.kind === "rejected") {
            return yield* Effect.fail(failure("commit", "constraint"));
          }
          const committed = Schema.decodeUnknownOption(CommunityCreationIntentContract)({
            ...document,
            revision: transitioned.state.revision,
            status: transitioned.state.status,
            next_action: creationNextAction(transitioned.state),
            committed_resource: resource,
          });
          if (Option.isNone(committed)) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }

          yield* transaction.execute({
            label: "community.creation.commit.insert-community",
            text: `INSERT INTO communities (
                     community_id, display_name, status, created_by_user_id,
                     created_at, updated_at, membership_mode,
                     human_verification_lane, route_slug, description,
                     canonical_route_binding_id, route_authority_version
                   ) VALUES (
                     $1, $2, 'active', $3, clock_timestamp(), clock_timestamp(),
                     'gated', 'very', NULL, $4, $5, 'route_v1'
                   )`,
            values: [
              communityId,
              document.draft.name,
              input.actor.userId,
              document.draft.description,
              routeBindingId,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-canonical-route",
            text: `INSERT INTO community_canonical_route_bindings (
                     route_binding_id, community_id, family, root_label,
                     root_label_display, ownership_status, route_lifecycle_status,
                     binding_generation, verified_evidence_ref
                   ) VALUES ($1, $2, $3, $4, $5, 'verified', 'active', $6, $7)`,
            values: [
              routeBindingId,
              communityId,
              compiledDraft.route.family,
              compiledDraft.route.root_label,
              compiledDraft.route.root_label_display,
              namespaceGeneration,
              namespaceAuthority.evidence_ref,
            ],
            readonly: false,
          });
          const effectiveRoute = yield* transaction.execute<Row>({
            label: "community.creation.commit.require-effective-route",
            text: `SELECT route_binding_id
                     FROM effective_active_route($1, $2::timestamptz)`,
            values: [communityId, activationNow],
            readonly: false,
          });
          const effectiveRouteRow = oneRow(effectiveRoute.rows);
          if (
            effectiveRouteRow === undefined ||
            effectiveRouteRow === null ||
            asString(effectiveRouteRow.route_binding_id) !== routeBindingId
          ) {
            return yield* Effect.fail(failure("commit", "constraint"));
          }
          yield* transaction.execute({
            label: "community.creation.commit.insert-policy",
            text: `INSERT INTO policy_versions (
                     policy_version_id, community_id, policy_key, revision,
                     policy_hash, policy, compiled_plan, compiler_version,
                     uniqueness_model, created_by_user_id, published_at,
                     policy_purpose
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
                     '{"kind":"none"}'::jsonb, $9, clock_timestamp(), 'access'
                   )`,
            values: [
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_revision,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_hash,
              JSON.stringify(CURATED_HUMAN_MEMBERSHIP_POLICY),
              JSON.stringify(compilation.compiled_plan),
              compilation.compiled_plan.compiler_version,
              input.actor.userId,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-provider-binding",
            text: `INSERT INTO community_policy_provider_bindings (
                     community_id, policy_key, policy_version_id,
                     verification_requirement_hash, provider_id,
                     provider_configuration_kind, provider_configuration_ref,
                     provider_configuration_version, method, protocol_version,
                     issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
                     request_mode, evaluator_id
                   ) VALUES (
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     $11, $12, $13, NULL, 'dynamic', $14
                   )`,
            values: [
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
              document.requirements.human_identity.requirement_hash,
              compilation.provider_binding.provider_id,
              compilation.provider_binding.provider_configuration.kind,
              compilation.provider_binding.provider_configuration.reference,
              compilation.provider_binding.provider_configuration.version,
              compilation.provider_binding.method,
              compilation.provider_binding.protocol_version,
              compilation.provider_binding.scope.issuer,
              compilation.provider_binding.scope.scope_semantics,
              compilation.provider_binding.scope.rp_scope,
              compilation.compiled_plan.evaluator,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-current-policy",
            text: `INSERT INTO community_policy_current (
                     community_id, policy_key, policy_version_id, activated_at
                   ) VALUES ($1, $2, $3, clock_timestamp())`,
            values: [
              communityId,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_key,
              CURATED_HUMAN_MEMBERSHIP_POLICY.policy_version_id,
            ],
            readonly: false,
          });
          yield* transaction.execute({
            label: "community.creation.commit.insert-subject-claim",
            text: `INSERT INTO community_creation_subject_claims (
                     claim_id, subject_key_id, actor_id, slot_number, approval_id,
                     intent_id, community_id, proof_session_id, evidence_receipt_id,
                     verification_requirement_hash
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            values: [
              subjectClaimId,
              evidence.subjectKeyId,
              input.actor.userId,
              slotNumber,
              approvalId,
              input.intentId,
              communityId,
              evidence.proofSessionId,
              evidence.evidenceReceiptId,
              document.requirements.human_identity.requirement_hash,
            ],
            readonly: false,
          });
          const updated = yield* transaction.execute({
            label: "community.creation.commit.persist-intent",
            text: `UPDATE community_creation_intents
                      SET revision = $1, status = 'committed',
                          committed_community_id = $2, committed_resource_href = $3,
                          updated_at = clock_timestamp()
                    WHERE intent_id = $4 AND actor_id = $5 AND revision = $6
                      AND status = 'commit_ready'
                      AND expires_at > clock_timestamp()`,
            values: [
              committed.value.revision,
              communityId,
              resource.href,
              input.intentId,
              input.actor.userId,
              document.revision,
            ],
            readonly: false,
          });
          if (updated.rowCount !== 1) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          const updatedRow = yield* loadLockedIntent(
            transaction,
            input.actor.userId,
            input.intentId,
            "commit",
          );
          if (updatedRow === null) return yield* Effect.fail(failure("commit", "invalid-row"));
          const stored = documentFromRow(updatedRow);
          if (stored === null || JSON.stringify(stored) !== JSON.stringify(committed.value)) {
            return yield* Effect.fail(failure("commit", "invalid-row"));
          }
          yield* insertRevision(transaction, {
            intent: stored,
            actorId: input.actor.userId,
            operation: "commit",
            idempotencyKey: body.idempotency_key,
            requestHash: input.requestHash,
          });
          return { document: stored, outcome: "fresh_created" as const };
        }),
      );
    });

  return { create, get, update, commit };
}

export function makeControlPlaneCommunityCreationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: CommunityCreationRepositoryOptions = {},
): CommunityCreationStore["Service"] {
  const repository = makeControlPlaneCommunityCreationRepository(options);
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    create: (input) => provide(repository.create(input)),
    get: (input) => provide(repository.get(input)),
    update: (input) => provide(repository.update(input)),
    commit: (input) => provide(repository.commit(input)),
  };
}
