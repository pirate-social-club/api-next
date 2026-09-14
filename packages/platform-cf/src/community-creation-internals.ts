/** Package-internal SQL and projections shared by activation and settlement. */
import {
  type CommunityCreationIntentDocument,
  CommunityCreationRepositoryError,
  type CommunityCreationRepositoryFailure,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  publicCommunityCreationRequirements,
  publicOptionalRouteCommunityCreationRequirements,
} from "@pirate/application";
import { VerificationCompletionStorageFailed } from "@pirate/application/verification";
import {
  CommunityCreationIntent as CommunityCreationIntentContract,
  type CreationNationalityRequirementProgressV2,
  PublicPersonaV1,
} from "@pirate/contracts";
import {
  COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  type CommunityCreationIntentState,
  type CreationRequirementProgress,
  canonicalRouteView,
  communityCreationCeremonyReservationHash,
} from "@pirate/domain";
import { Effect, Option, Schema } from "effect";

export type Row = Readonly<Record<string, unknown>>;

export const SHA256_HEX = /^[0-9a-f]{64}$/u;

export const VERY_WEB_EVIDENCE_KIND = "very.web.server-verified.v1";

export const TERMINAL_STATUSES = new Set([
  "committed",
  "quota_exceeded",
  "gate_unsupported",
  "expired",
  "cancelled",
]);

export const HUMAN_MEMBERSHIP_REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const;

export const HUMAN_MEMBERSHIP_CLAIM_IDS = [
  "credential.subject_unique",
  "human.personhood",
] as const;

export function failure(
  operation: "create" | "get" | "update" | "commit",
  reason: "not-found" | "idempotency-conflict" | "revision-conflict" | "constraint" | "invalid-row",
): CommunityCreationRepositoryError {
  return new CommunityCreationRepositoryError({ operation, reason });
}

export function validId(value: string): boolean {
  return value.length > 0 && value.trim() === value && !value.includes("\u0000");
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asPositiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function asNonNegativeInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function asTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function oneRow(rows: readonly Row[]): Row | null | undefined {
  if (rows.length > 1) return undefined;
  return rows[0] ?? null;
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

type CreationNationalityProgress = Readonly<{
  readonly accepted_provider_ids: readonly ["self.pass", "zkpassport"];
  readonly requirement: "nationality";
  readonly status: "pending" | "satisfied";
  readonly requirement_hash: string;
  readonly provider_id: "self.pass" | "zkpassport";
  readonly generation: number;
  readonly ceremony_intent_id: string;
  readonly satisfied_at: string | null;
}>;

/**
 * Parses the locked loader's nationality projection. Absent means the creator
 * carries no nationality requirement; a present but malformed row fails closed
 * rather than silently dropping a policy requirement.
 */
function nationalityRequirementFromValue(value: unknown): CreationNationalityProgress | null {
  const record = jsonValue(value);
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const row = record as Row;
  const accepted = jsonValue(row.accepted_provider_ids);
  if (
    !Array.isArray(accepted) ||
    accepted.length !== 2 ||
    accepted[0] !== "self.pass" ||
    accepted[1] !== "zkpassport"
  )
    return null;
  const status = asString(row.status);
  if (status !== "pending" && status !== "satisfied") return null;
  const generation = asPositiveInteger(row.generation);
  const requirementHash = asString(row.requirement_hash);
  const providerId = asString(row.provider_id);
  const ceremonyIntentId = asString(row.current_ceremony_intent_id);
  const satisfiedAt = row.satisfied_at === null ? null : asTimestamp(row.satisfied_at);
  if (
    generation === null ||
    requirementHash === null ||
    !SHA256_HEX.test(requirementHash) ||
    (providerId !== "self.pass" && providerId !== "zkpassport") ||
    ceremonyIntentId === null ||
    (row.satisfied_at !== null && satisfiedAt === null)
  ) {
    return null;
  }
  return {
    requirement: "nationality",
    accepted_provider_ids: ["self.pass", "zkpassport"],
    status,
    requirement_hash: requirementHash,
    provider_id: providerId,
    generation,
    ceremony_intent_id: ceremonyIntentId,
    satisfied_at: satisfiedAt,
  };
}

function nextActionFromRequirements(
  row: Row,
  input: Readonly<{
    readonly intentId: string;
    readonly status: string;
    readonly contractVersion: "route_v1" | "optional_route_v2";
    readonly human: CreationRequirementProgress | null;
    readonly namespace: CreationRequirementProgress | null;
    readonly nationality: CreationNationalityRequirementProgressV2 | null;
    readonly nationalityStarted: boolean;
  }>,
) {
  if (input.status === "draft") {
    return { kind: "wait", requirement: null, reason_code: "operation_pending" } as const;
  }
  if (input.status === "verification_required") {
    if (input.contractVersion === "optional_route_v2") {
      const candidates: readonly (readonly [
        "human_identity" | "nationality",
        Readonly<{
          readonly status: string;
          readonly provider_id: string;
          readonly ceremony_intent_id: string | null;
          readonly generation: number;
        }>,
        boolean,
      ])[] = [
        ...(input.human === null
          ? []
          : ([["human_identity", input.human, row.human_started === true]] as const)),
        ...(input.nationality === null
          ? []
          : ([["nationality", input.nationality, input.nationalityStarted]] as const)),
      ];
      for (const [requirement, progress, started] of candidates) {
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
      // A verification-required post-amendment intent always carries a pending
      // creator requirement; anything else is invalid, never requirement-free.
      return input.human === null && input.nationality === null
        ? null
        : ({ kind: "wait", requirement: null, reason_code: "reconciliation_pending" } as const);
    }
    // A requirement-free intent never waits on a creator ceremony.
    if (input.human === null) return null;
    const requirements: readonly (readonly [
      "human_identity" | "namespace_ownership",
      CreationRequirementProgress,
      boolean,
    ])[] = [
      ["human_identity", input.human, row.human_started === true],
      [
        "namespace_ownership",
        input.namespace as CreationRequirementProgress,
        row.namespace_started === true,
      ],
    ];
    for (const [requirement, progress, started] of requirements) {
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
  if (input.status === "commit_ready") {
    if (
      input.contractVersion === "optional_route_v2" &&
      typeof row.minted_persona_id === "string" &&
      row.creator_persona_status !== "active"
    ) {
      return { kind: "activate_profile", persona_id: row.minted_persona_id } as const;
    }
    return { kind: "commit" } as const;
  }
  if (input.status === "quota_exceeded" || input.status === "gate_unsupported") {
    return { kind: "blocked", reason: input.status } as const;
  }
  if (input.status === "committed" || input.status === "expired" || input.status === "cancelled") {
    return { kind: "none", reason: input.status } as const;
  }
  return null;
}

export function documentFromRow(row: Row): CommunityCreationIntentDocument | null {
  const intentId = asString(row.intent_id);
  const revision = asPositiveInteger(row.revision);
  const status = asString(row.status);
  const canonicalPolicyRevision = asPositiveInteger(row.canonical_policy_revision);
  const canonicalPolicyHash = asString(row.canonical_policy_hash);
  const requirementHash = asString(row.verification_requirement_hash);
  const providerId = asString(row.verification_provider_id);
  const expiresAt = asTimestamp(row.expires_at);
  const contractVersion = asString(row.creation_contract_version);
  const publicPersona = Schema.decodeUnknownOption(PublicPersonaV1)(
    jsonValue(row.persona_projection),
  );
  // A create_new draft has no persona until the terminal creation commit
  // mints one; its presentation stays null until then (spec 014 11.2).
  const draftPersonaKind = jsonValue(row.draft);
  const createNewOwner =
    draftPersonaKind !== null &&
    typeof draftPersonaKind === "object" &&
    "persona" in draftPersonaKind &&
    draftPersonaKind.persona !== null &&
    typeof draftPersonaKind.persona === "object" &&
    "kind" in draftPersonaKind.persona &&
    draftPersonaKind.persona.kind === "create_new";
  const human = requirementFromValue(row.human_requirement, "human_identity");
  const namespace = requirementFromValue(row.namespace_requirement, "namespace_ownership");
  const rawNationality = row.nationality_requirement ?? null;
  const nationality =
    rawNationality === null ? null : nationalityRequirementFromValue(rawNationality);
  if (rawNationality !== null && nationality === null) return null;
  // Post-amendment optional-route intents carry no creator authority and no
  // requirement row; grandfathered and route-v1 intents carry both.
  const requirementFree =
    contractVersion === "optional_route_v2" &&
    requirementHash === null &&
    providerId === null &&
    row.human_requirement === null;
  if (
    intentId === null ||
    revision === null ||
    status === null ||
    canonicalPolicyRevision === null ||
    canonicalPolicyHash === null ||
    (!requirementFree && (requirementHash === null || providerId === null || human === null)) ||
    expiresAt === null ||
    (contractVersion !== "route_v1" && contractVersion !== "optional_route_v2") ||
    (contractVersion === "route_v1" && namespace === null) ||
    (contractVersion === "optional_route_v2" && row.namespace_requirement !== null) ||
    (contractVersion === "optional_route_v2" && Option.isNone(publicPersona) && !createNewOwner) ||
    (nationality !== null && contractVersion !== "optional_route_v2") ||
    (nationality !== null && nationality.status === "pending" && status !== "verification_required")
  ) {
    return null;
  }
  const personaRolePresentation =
    contractVersion === "optional_route_v2" &&
    Option.isSome(publicPersona) &&
    (row.minted_persona_id === null || row.creator_persona_status === "active")
      ? ({ role: "owner" as const, persona: publicPersona.value } as const)
      : null;
  const nextAction = nextActionFromRequirements(row, {
    intentId,
    status,
    contractVersion,
    human,
    namespace,
    nationality,
    nationalityStarted: row.nationality_started === true,
  });
  if (nextAction === null) return null;
  let committedResource: CommunityCreationIntentDocument["committed_resource"] = null;
  let committedStateResource: CommunityCreationIntentState["committed_resource"] = null;
  if (row.committed_community_id !== null || row.committed_resource_href !== null) {
    const communityId = asString(row.committed_community_id);
    const resourceHref = asString(row.committed_resource_href);
    if (communityId === null || resourceHref === null) return null;
    committedStateResource = { community_id: communityId, href: resourceHref };
    if (contractVersion === "optional_route_v2") {
      if (personaRolePresentation === null) return null;
      committedResource = {
        authority_version: "optional_route_v2",
        community_id: communityId,
        href: resourceHref,
        canonical_route: null,
        persona_role_presentation: personaRolePresentation,
      };
    } else {
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
      committedResource = {
        community_id: communityId,
        href: resourceHref,
        canonical_route: canonicalRouteView(
          {
            family,
            root_label: rootLabel,
            root_label_display: rootLabelDisplay,
            path_segment: pathSegment,
            href,
          },
          row.committed_app_host_healthy === true,
        ),
      };
    }
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
    committed_resource: committedStateResource,
    ...(nationality === null
      ? {}
      : {
          nationality: {
            status: nationality.status,
            requirement_hash: nationality.requirement_hash,
            provider_id: nationality.provider_id,
            generation: nationality.generation,
            ceremony_intent_id: nationality.ceremony_intent_id,
            satisfied_at: nationality.satisfied_at,
            started: row.nationality_started === true,
          },
        }),
  };
  if (contractVersion === "route_v1" && (human === null || namespace === null)) return null;
  const publicIntent = {
    ...(contractVersion === "optional_route_v2"
      ? { creation_contract_version: "optional_route_v2" as const }
      : {}),
    intent_id: state.intent_id,
    revision: state.revision,
    status: state.status,
    draft: jsonValue(row.draft),
    canonical_policy_revision: state.canonical_policy_revision,
    canonical_policy_hash: state.canonical_policy_hash,
    requirements:
      contractVersion === "optional_route_v2"
        ? publicOptionalRouteCommunityCreationRequirements(human, nationality)
        : publicCommunityCreationRequirements({
            human_identity: human as CreationRequirementProgress,
            namespace_ownership: namespace as CreationRequirementProgress,
          }),
    next_action: nextAction,
    expires_at: state.expires_at,
    ...(contractVersion === "optional_route_v2"
      ? { persona_role_presentation: personaRolePresentation }
      : {}),
    committed_resource: committedResource,
  };
  const decoded = Schema.decodeUnknownOption(CommunityCreationIntentContract)(publicIntent);
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
          ${column("minted_persona_id")},
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
          (
            SELECT jsonb_build_object(
              'status', state.status,
              'requirement_hash', state.requirement_hash,
              'provider_id', state.current_provider_id,
              'accepted_provider_ids', state.accepted_provider_ids,
              'generation', state.generation,
              'current_ceremony_intent_id', state.current_ceremony_intent_id,
              'satisfied_at', state.satisfied_at
            )
              FROM nationality_requirement_states AS state
             WHERE state.action_kind = 'community_creation'
               AND state.intent_id = ${intentAlias}.intent_id
               AND state.requirement_kind = 'nationality'
          ) AS nationality_requirement,
          EXISTS (
            SELECT 1 FROM proof_sessions AS proof
             WHERE proof.intent_id = (
               SELECT state.current_ceremony_intent_id
                 FROM nationality_requirement_states AS state
                WHERE state.action_kind = 'community_creation'
                  AND state.intent_id = ${intentAlias}.intent_id
                  AND state.requirement_kind = 'nationality'
             )
               AND proof.actor_id = ${intentAlias}.actor_id
               AND proof.creation_ceremony_intent_id IS NULL
          ) AS nationality_started,
          (
            SELECT public_persona_projection(persona.persona_id)
              FROM personas AS persona
             WHERE persona.account_id = ${intentAlias}.actor_id
               AND persona.persona_id = COALESCE(
                 ${intentAlias}.draft -> 'persona' ->> 'persona_id',
                 ${intentAlias}.minted_persona_id
               )
          ) AS persona_projection,
          (SELECT persona.status FROM personas AS persona
            WHERE persona.account_id = ${intentAlias}.actor_id
              AND persona.persona_id = ${intentAlias}.minted_persona_id) AS creator_persona_status,
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

export function loadLockedIntent(
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
                AND intent.creation_contract_version IN ('route_v1', 'optional_route_v2')
              FOR UPDATE OF intent`,
      values: [intentId, actorId, databaseNow ?? null],
      readonly: false,
    });
    const row = oneRow(result.rows);
    if (row === undefined) return yield* Effect.fail(failure(operation, "invalid-row"));
    return row;
  });
}

export function insertRevision(
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

export function reserveNextCreationRequirement(
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
      text: `SELECT state.requirement_kind, state.status, state.requirement_hash, state.provider_id,
                    state.provider_binding_hash, state.provider_configuration_kind,
                    state.provider_configuration_ref, state.provider_configuration_version,
                    state.route_family, state.route_root_label, state.route_root_label_display,
                    state.route_path_segment, state.generation, state.current_ceremony_intent_id,
                    intent.creation_contract_version
               FROM community_creation_requirement_states AS state
               JOIN community_creation_intents AS intent
                 ON intent.intent_id = state.intent_id AND intent.actor_id = state.actor_id
              WHERE state.intent_id = $1 AND state.actor_id = $2
              ORDER BY CASE requirement_kind
                WHEN 'human_identity' THEN 1
                WHEN 'namespace_ownership' THEN 2
              END
              FOR UPDATE`,
      values: [input.intentId, input.actorId],
      readonly: false,
    });
    const contractVersion = asString(result.rows[0]?.creation_contract_version);
    const expectedRequirementCount = contractVersion === "optional_route_v2" ? 1 : 2;
    if (
      (contractVersion !== "route_v1" && contractVersion !== "optional_route_v2") ||
      result.rows.length !== expectedRequirementCount ||
      result.rows.some((row) => row.creation_contract_version !== contractVersion)
    ) {
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
                AND intent.creation_contract_version IN ('route_v1', 'optional_route_v2')
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

export function verificationStorageFailure(): VerificationCompletionStorageFailed {
  return new VerificationCompletionStorageFailed();
}

export function exactCanonicalJson(value: unknown, expected: unknown): boolean {
  return JSON.stringify(jsonValue(value)) === JSON.stringify(expected);
}

export type CommitEvidence = Readonly<{
  readonly proofSessionId: string;
  readonly evidenceReceiptId: string;
  readonly evidenceDigest: string;
  readonly subjectKeyId: string;
  readonly subjectDigest: string;
  readonly receiptExpiresAt: string | null;
  readonly assertionExpiresAt: string | null;
}>;

export function loadCommitEvidence(
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
      values: [input.proofSessionId, VERY_WEB_EVIDENCE_KIND, input.actorId],
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
