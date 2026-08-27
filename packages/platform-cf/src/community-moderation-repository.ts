import {
  type CommunityContentReportOutcome,
  type CommunityModerationCapabilities,
  type CommunityModerationCaseDetail,
  type CommunityModerationCaseList,
  type CommunityModerationPolicy,
  CommunityModerationStoreError,
  type CommunityModerationStoreOperation,
  type CommunityModerationStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
} from "@pirate/application";
import {
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyCategoryV1,
  type ModerationPolicyDecisionV1,
} from "@pirate/contracts";
import { Effect, type Layer, Predicate } from "effect";

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type Operation = CommunityModerationStoreOperation;
type RepositoryMethod<M> = M extends (input: infer I) => Effect.Effect<infer A, infer E, unknown>
  ? (input: I) => Effect.Effect<A, E, ControlPlaneDb>
  : never;
type RepositoryService = {
  readonly [K in keyof CommunityModerationStoreService]: RepositoryMethod<
    CommunityModerationStoreService[K]
  >;
};

const HASH = /^[0-9a-f]{64}$/u;
const ACTIONS = [
  "approve_as_general",
  "approve_as_adult_18",
  "reject",
  "dismiss_report",
  "hide",
  "raise_rating_to_adult_18",
  "restore",
] as const;
type Action = (typeof ACTIONS)[number];
type TargetStatus = "held" | "published" | "hidden" | "blocked";
type ViewState = "open" | "hidden" | "resolved";

const failure = (
  operation: Operation,
  reason:
    | "not-found"
    | "membership-required"
    | "idempotency-conflict"
    | "conflict"
    | "constraint"
    | "invalid-row",
  resourceId?: string,
) =>
  new CommunityModerationStoreError({
    operation,
    reason,
    ...(resourceId === undefined ? {} : { resourceId }),
  });

const mapDatabaseFailure = <A>(
  operation: Operation,
  effect: Effect.Effect<A, CommunityModerationStoreError | ControlPlaneError, ControlPlaneDb>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof CommunityModerationStoreError ? error : failure(operation, "invalid-row"),
    ),
  );

const stringValue = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === "string" ? value : null;
};
const integerValue = (row: Row, key: string): number | null => {
  const value = row[key];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};
const booleanValue = (row: Row, key: string): boolean | null => {
  const value = row[key];
  return typeof value === "boolean" ? value : null;
};
const isoValue = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
};
const validId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");
const makeId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

const severity = (decision: ModerationPolicyDecisionV1): number =>
  decision === "permit" ? 1 : decision === "review" ? 2 : 3;

const ownerAssignment = asyncQuery`
  SELECT assignment.role_assignment_id
    FROM community_role_assignments AS assignment
   WHERE assignment.community_id = $1
     AND assignment.account_id = $2
     AND assignment.role = 'owner'
     AND assignment.status = 'active'
     AND has_community_moderation_capability_v1($2, $1, $3)
`;

function asyncQuery(strings: TemplateStringsArray): string {
  return strings.join("");
}

const requireOwner = (
  transaction: Pick<Transaction, "execute">,
  operation: Operation,
  communityId: string,
  accountId: string,
  capability: "moderation.view" | "moderation.act",
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: `community-moderation.${operation}.owner`,
      text: ownerAssignment,
      values: [communityId, accountId, capability],
      readonly: true,
    });
    const assignmentId =
      result.rows.length === 1 ? stringValue(result.rows[0] as Row, "role_assignment_id") : null;
    if (assignmentId === null) return yield* Effect.fail(failure(operation, "not-found"));
    return assignmentId;
  });

const policyQuery = `
  SELECT revision.policy_revision_id, revision.policy_hash, revision.revision,
         revision.platform_floor_revision_id, revision.platform_floor_hash,
         current.updated_at, community_choice.category,
         community_choice.decision AS community_decision,
         floor_choice.decision AS floor_decision
    FROM community_moderation_policy_current AS current
    JOIN community_moderation_policy_revisions AS revision
      ON revision.community_id = current.community_id
     AND revision.policy_revision_id = current.policy_revision_id
     AND revision.policy_hash = current.policy_hash
    JOIN community_moderation_policy_category_decisions AS community_choice
      ON community_choice.community_id = revision.community_id
     AND community_choice.policy_revision_id = revision.policy_revision_id
    JOIN moderation_platform_floor_category_decisions AS floor_choice
      ON floor_choice.policy_revision_id = revision.platform_floor_revision_id
     AND floor_choice.category = community_choice.category
   WHERE current.community_id = $1
   ORDER BY moderation_policy_category_ordinal_v1(community_choice.category)`;

const policyFromRows = (
  communityId: string,
  rows: readonly Row[],
): CommunityModerationPolicy | null => {
  if (rows.length !== MODERATION_POLICY_CATEGORIES_V1.length) return null;
  const first = rows[0];
  if (first === undefined) return null;
  const policyRevisionId = stringValue(first, "policy_revision_id");
  const policyHash = stringValue(first, "policy_hash");
  const revision = integerValue(first, "revision");
  const platformFloorRevisionId = stringValue(first, "platform_floor_revision_id");
  const platformFloorHash = stringValue(first, "platform_floor_hash");
  const updatedAt = isoValue(first, "updated_at");
  if (
    policyRevisionId === null ||
    policyHash === null ||
    revision === null ||
    platformFloorRevisionId === null ||
    platformFloorHash === null ||
    updatedAt === null
  ) {
    return null;
  }
  const categories: CommunityModerationPolicy["categories"][number][] = [];
  for (const [index, row] of rows.entries()) {
    const category = stringValue(row, "category") as ModerationPolicyCategoryV1 | null;
    const communityDecision = stringValue(
      row,
      "community_decision",
    ) as ModerationPolicyDecisionV1 | null;
    const floorDecision = stringValue(row, "floor_decision") as ModerationPolicyDecisionV1 | null;
    if (
      category !== MODERATION_POLICY_CATEGORIES_V1[index] ||
      communityDecision === null ||
      floorDecision === null ||
      !["permit", "review", "block"].includes(communityDecision) ||
      !["permit", "review", "block"].includes(floorDecision)
    ) {
      return null;
    }
    const effectiveDecision =
      severity(communityDecision) >= severity(floorDecision) ? communityDecision : floorDecision;
    categories.push({
      category,
      input_types: ["text"],
      platform_floor_decision: floorDecision,
      community_decision: communityDecision,
      effective_decision: effectiveDecision,
      locked: floorDecision !== "permit",
      permit_rating:
        category === "sexual" || category === "violence/graphic" ? "adult_18" : "general",
    });
  }
  return {
    version: "community-moderation-policy-v1",
    community_id: communityId,
    policy_revision_id: policyRevisionId,
    policy_hash: policyHash,
    revision,
    platform_floor_revision_id: platformFloorRevisionId,
    platform_floor_hash: platformFloorHash,
    categories,
    updated_at: updatedAt,
  };
};

const permittedActions = (
  source: "automatic" | "member_report" | "mixed",
  status: TargetStatus,
  rating: "general" | "adult_18",
  adultCapable = false,
): readonly Action[] => {
  if (status === "held")
    return rating === "adult_18"
      ? adultCapable
        ? ["approve_as_adult_18", "reject"]
        : ["reject"]
      : ["approve_as_general", "approve_as_adult_18", "reject"];
  if (status === "published") {
    if (rating === "adult_18")
      return source === "member_report" || source === "mixed"
        ? adultCapable
          ? ["dismiss_report", "hide"]
          : ["hide"]
        : ["hide"];
    return source === "member_report" || source === "mixed"
      ? ["dismiss_report", "hide", "raise_rating_to_adult_18"]
      : ["hide", "raise_rating_to_adult_18"];
  }
  if (status === "hidden") return rating === "adult_18" && !adultCapable ? [] : ["restore"];
  return [];
};

const caseSummary = (
  row: Row,
  adultCapable = false,
): CommunityModerationCaseList["items"][number] | null => {
  const caseRef = stringValue(row, "case_ref");
  const communityId = stringValue(row, "community_id");
  const targetType = stringValue(row, "target_type") as "text_post" | "comment" | "reply" | null;
  const source = stringValue(row, "source") as "automatic" | "member_report" | "mixed" | null;
  const targetStatus = stringValue(row, "target_status") as TargetStatus | null;
  const rating = (stringValue(row, "resulting_content_rating") ?? "adult_18") as
    | "general"
    | "adult_18";
  const personaId = stringValue(row, "author_persona_id");
  const caseRevision = integerValue(row, "case_revision");
  const createdAt = isoValue(row, "created_at");
  const updatedAt = isoValue(row, "updated_at");
  if (
    caseRef === null ||
    communityId === null ||
    targetType === null ||
    source === null ||
    targetStatus === null ||
    !["held", "published", "hidden", "blocked"].includes(targetStatus) ||
    !["general", "adult_18"].includes(rating) ||
    personaId === null ||
    caseRevision === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    case_ref: caseRef,
    community_id: communityId,
    target_type: targetType,
    target_id: stringValue(row, "target_resource_id"),
    author_persona_id: personaId,
    source,
    target_status: targetStatus,
    resulting_content_rating: rating,
    case_revision: caseRevision,
    permitted_actions: [...permittedActions(source, targetStatus, rating, adultCapable)],
    created_at: createdAt,
    updated_at: updatedAt,
  };
};

const caseSelect = `
  SELECT moderation_case.case_ref, moderation_case.community_id,
         moderation_case.submission_id, moderation_case.target_type,
         moderation_case.target_resource_id, moderation_case.source,
         moderation_case.view_state, moderation_case.target_status,
         moderation_case.case_revision, moderation_case.created_at,
         moderation_case.updated_at, submission.author_persona_id,
         submission.actor_user_id, submission.status AS submission_status,
         submission.idempotency_key, submission.request_hash,
         submission.target_post_id, submission.target_parent_comment_id,
         submission.author_declared_rating, submission.resulting_content_rating,
         submission.matched_categories, submission.category_decisions,
         submission.effective_policy_decision, submission.policy_revision_id,
         submission.policy_hash, submission.platform_policy_revision_id,
         submission.platform_policy_hash, submission.community_policy_revision_id,
         submission.community_policy_hash, submission.evidence_ref,
         held.title AS held_title,
         held.body AS held_body, post.title AS post_title, post.body AS post_body,
         comment.body AS comment_body, evidence.normalized_scores,
         evidence.applied_input_types
    FROM community_moderation_cases_v2 AS moderation_case
    JOIN text_content_submissions AS submission
      ON submission.community_id = moderation_case.community_id
     AND submission.submission_id = moderation_case.submission_id
    LEFT JOIN text_content_held_revisions AS held
      ON held.community_id = submission.community_id
     AND held.submission_id = submission.submission_id
    LEFT JOIN posts AS post
      ON post.community_id = moderation_case.community_id
     AND post.post_id = moderation_case.target_resource_id
    LEFT JOIN comments AS comment
      ON comment.community_id = moderation_case.community_id
     AND comment.comment_id = moderation_case.target_resource_id
    LEFT JOIN text_moderation_evidence AS evidence
      ON evidence.evidence_ref = submission.evidence_ref`;

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | null =>
  Predicate.isObject(value) ? (value as Readonly<Record<string, unknown>>) : null;

const providerEvidence = (row: Row) => {
  const scores: Partial<Record<ModerationPolicyCategoryV1, number>> = {};
  const applied: Partial<Record<ModerationPolicyCategoryV1, readonly ("text" | "image")[]>> = {};
  const nestedScores = recordValue(row.normalized_scores);
  if (nestedScores !== null) {
    for (const inputScores of Object.values(nestedScores)) {
      const values = recordValue(inputScores);
      if (values === null) continue;
      for (const category of MODERATION_POLICY_CATEGORIES_V1) {
        const score = values[category];
        if (typeof score === "number" && Number.isFinite(score)) {
          scores[category] = Math.max(scores[category] ?? 0, score);
        }
      }
    }
  }
  const nestedApplied = recordValue(row.applied_input_types);
  if (nestedApplied !== null) {
    for (const inputApplied of Object.values(nestedApplied)) {
      const values = recordValue(inputApplied);
      if (values === null) continue;
      for (const category of MODERATION_POLICY_CATEGORIES_V1) {
        const types = values[category];
        if (!Array.isArray(types)) continue;
        const accepted = types.filter(
          (value): value is "text" | "image" => value === "text" || value === "image",
        );
        if (accepted.length > 0)
          applied[category] = [...new Set([...(applied[category] ?? []), ...accepted])];
      }
    }
  }
  return { scores, applied };
};

export function makeControlPlaneCommunityModerationRepository(): RepositoryService {
  const getCapabilities: RepositoryService["getCapabilities"] = (input) =>
    mapDatabaseFailure(
      "capabilities",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.communityId) ||
          !validId(input.actor.userId)
        ) {
          return yield* Effect.fail(failure("capabilities", "not-found"));
        }
        const db = yield* ControlPlaneDb;
        const assignmentId = yield* requireOwner(
          db,
          "capabilities",
          input.communityId,
          input.actor.userId,
          "moderation.view",
        );
        return {
          community_id: input.communityId,
          role: "owner" as const,
          role_assignment_id: assignmentId,
          capabilities: ["moderation.view", "moderation.act"] as const,
        } satisfies CommunityModerationCapabilities;
      }),
    );

  const listCases: RepositoryService["listCases"] = (input) =>
    mapDatabaseFailure(
      "list",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.communityId) ||
          !["open", "hidden"].includes(input.view)
        ) {
          return yield* Effect.fail(failure("list", "not-found"));
        }
        const db = yield* ControlPlaneDb;
        yield* requireOwner(db, "list", input.communityId, input.actor.userId, "moderation.view");
        const result = yield* db.execute<Row>({
          label: "community-moderation.list-cases",
          text: `${caseSelect}
                  WHERE moderation_case.community_id = $1
                    AND moderation_case.visibility = 'owner'
                    AND moderation_case.view_state = $2
                  ORDER BY moderation_case.updated_at DESC, moderation_case.case_ref`,
          values: [input.communityId, input.view],
          readonly: true,
        });
        const capability = yield* db.execute<Row>({
          label: "community-moderation.list-age-capability",
          text: "SELECT current_account_age_capability_v1($1) AS capability",
          values: [input.actor.userId],
          readonly: true,
        });
        const adultCapable =
          capability.rows.length === 1 &&
          stringValue(capability.rows[0] as Row, "capability") === "adult_18";
        const items = result.rows.map((row) => caseSummary(row as Row, adultCapable));
        if (items.some((item) => item === null))
          return yield* Effect.fail(failure("list", "invalid-row"));
        return {
          object: "community_moderation_case_list" as const,
          community_id: input.communityId,
          view: input.view,
          items: items as CommunityModerationCaseList["items"],
        };
      }),
    );

  const getCase: RepositoryService["getCase"] = (input) =>
    mapDatabaseFailure(
      "detail",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.communityId) ||
          !validId(input.caseRef)
        ) {
          return yield* Effect.fail(failure("detail", "not-found"));
        }
        const db = yield* ControlPlaneDb;
        yield* requireOwner(db, "detail", input.communityId, input.actor.userId, "moderation.view");
        const result = yield* db.execute<Row>({
          label: "community-moderation.get-case",
          text: `${caseSelect}
                  WHERE moderation_case.community_id = $1
                    AND moderation_case.case_ref = $2
                    AND moderation_case.visibility = 'owner'
                    AND moderation_case.view_state IN ('open', 'hidden')`,
          values: [input.communityId, input.caseRef],
          readonly: true,
        });
        const row = result.rows.length === 1 ? (result.rows[0] as Row) : null;
        if (row === null) return yield* Effect.fail(failure("detail", "not-found"));
        const ageCapability = yield* db.execute<Row>({
          label: "community-moderation.get-case-age-capability",
          text: "SELECT current_account_age_capability_v1($1) AS capability",
          values: [input.actor.userId],
          readonly: true,
        });
        const canViewAdult =
          ageCapability.rows.length === 1 &&
          stringValue(ageCapability.rows[0] as Row, "capability") === "adult_18";
        const summary = caseSummary(row, canViewAdult);
        if (summary === null) return yield* Effect.fail(failure("detail", "invalid-row"));
        const authorRating = stringValue(row, "author_declared_rating");
        const resultingRating = stringValue(row, "resulting_content_rating");
        const matched = row.matched_categories;
        const decisions = recordValue(row.category_decisions);
        const effective = stringValue(row, "effective_policy_decision");
        const policyRevision = stringValue(row, "policy_revision_id");
        const policyHash = stringValue(row, "policy_hash");
        const platformRevision = stringValue(row, "platform_policy_revision_id");
        const platformHash = stringValue(row, "platform_policy_hash");
        const communityRevision = stringValue(row, "community_policy_revision_id");
        const communityHash = stringValue(row, "community_policy_hash");
        if (
          (authorRating !== "general" && authorRating !== "adult_18") ||
          (resultingRating !== "general" && resultingRating !== "adult_18") ||
          !Array.isArray(matched) ||
          decisions === null ||
          !["permit", "review", "block"].includes(effective ?? "") ||
          policyRevision === null ||
          policyHash === null ||
          platformRevision === null ||
          platformHash === null ||
          communityRevision === null ||
          communityHash === null
        ) {
          return yield* Effect.fail(failure("detail", "invalid-row"));
        }
        const provider = providerEvidence(row);
        const title = stringValue(row, "held_title") ?? stringValue(row, "post_title");
        const body =
          stringValue(row, "held_body") ??
          stringValue(row, "post_body") ??
          stringValue(row, "comment_body");
        const bounded = (value: string | null) =>
          value === null ? null : value.length <= 2_000 ? value : value.slice(0, 2_000);
        return {
          object: "community_moderation_case" as const,
          case: summary,
          preview:
            resultingRating === "adult_18" && !canViewAdult
              ? ({ kind: "locked", reason: "adult_rating" } as const)
              : ({ kind: "text", title: bounded(title), body: bounded(body) } as const),
          evidence: {
            matched_categories: matched as ModerationPolicyCategoryV1[],
            category_decisions:
              decisions as CommunityModerationCaseDetail["evidence"]["category_decisions"],
            effective_decision: effective as ModerationPolicyDecisionV1,
            resulting_content_rating: resultingRating,
            author_declared_rating: authorRating,
            provider_scores: provider.scores,
            applied_input_types: provider.applied,
            policy_revision: policyRevision,
            policy_hash: policyHash,
            platform_policy_revision: platformRevision,
            platform_policy_hash: platformHash,
            community_policy_revision: communityRevision,
            community_policy_hash: communityHash,
          },
        } satisfies CommunityModerationCaseDetail;
      }),
    );

  const getPolicy: RepositoryService["getPolicy"] = (input) =>
    mapDatabaseFailure(
      "policy-read",
      Effect.gen(function* () {
        if (input.actor.kind === "agent" || !validId(input.communityId)) {
          return yield* Effect.fail(failure("policy-read", "not-found"));
        }
        const db = yield* ControlPlaneDb;
        yield* requireOwner(
          db,
          "policy-read",
          input.communityId,
          input.actor.userId,
          "moderation.view",
        );
        const result = yield* db.execute<Row>({
          label: "community-moderation.read-policy",
          text: policyQuery,
          values: [input.communityId],
          readonly: true,
        });
        const policy = policyFromRows(input.communityId, result.rows as readonly Row[]);
        return policy === null ? yield* Effect.fail(failure("policy-read", "invalid-row")) : policy;
      }),
    );

  const updatePolicy: RepositoryService["updatePolicy"] = (input) =>
    mapDatabaseFailure(
      "policy-update",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.communityId) ||
          !validId(input.update.expected_policy_revision)
        ) {
          return yield* Effect.fail(failure("policy-update", "not-found"));
        }
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "community-moderation.update-policy",
          text: `SELECT (result).outcome, (result).policy_revision_id
                   FROM create_community_moderation_policy_revision_v1($1, $2, $3, $4::jsonb) AS result`,
          values: [
            input.actor.userId,
            input.communityId,
            input.update.expected_policy_revision,
            JSON.stringify(input.update.decisions),
          ],
          readonly: false,
        });
        const row = result.rows.length === 1 ? (result.rows[0] as Row) : null;
        const outcome = row === null ? null : stringValue(row, "outcome");
        if (outcome === "not_found")
          return yield* Effect.fail(failure("policy-update", "not-found"));
        if (outcome === "conflict") return yield* Effect.fail(failure("policy-update", "conflict"));
        if (outcome === "constraint")
          return yield* Effect.fail(failure("policy-update", "constraint"));
        if (outcome !== "updated")
          return yield* Effect.fail(failure("policy-update", "invalid-row"));
        const policyRows = yield* db.execute<Row>({
          label: "community-moderation.read-updated-policy",
          text: policyQuery,
          values: [input.communityId],
          readonly: true,
        });
        const policy = policyFromRows(input.communityId, policyRows.rows as readonly Row[]);
        return policy === null
          ? yield* Effect.fail(failure("policy-update", "invalid-row"))
          : policy;
      }),
    );

  const reportTarget: RepositoryService["reportTarget"] = (input) =>
    mapDatabaseFailure(
      "report",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.targetId) ||
          !validId(input.actor.userId) ||
          !validId(input.idempotencyKey) ||
          !HASH.test(input.requestHash)
        ) {
          return yield* Effect.fail(failure("report", "constraint"));
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "community-moderation.report-lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
              values: [
                JSON.stringify([
                  "community-report",
                  input.targetType,
                  input.targetId,
                  input.actor.userId,
                  input.idempotencyKey,
                ]),
              ],
              readonly: false,
            });
            const legacy =
              input.targetType === "comment"
                ? yield* transaction.execute<Row>({
                    label: "community-moderation.report-legacy-replay",
                    text: `SELECT report_id, case_ref, status, request_hash
                             FROM comment_reports
                            WHERE reporter_user_id = $1
                              AND comment_id = $2
                              AND idempotency_key = $3
                            FOR UPDATE`,
                    values: [input.actor.userId, input.targetId, input.idempotencyKey],
                    readonly: false,
                  })
                : { rows: [] as readonly Row[] };
            if (legacy.rows.length === 1) {
              const row = legacy.rows[0] as Row;
              if (stringValue(row, "request_hash") !== input.requestHash) {
                return yield* Effect.fail(
                  failure("report", "idempotency-conflict", input.targetId),
                );
              }
              const reportId = stringValue(row, "report_id");
              const caseRef = stringValue(row, "case_ref");
              const status = stringValue(row, "status");
              if (
                reportId === null ||
                caseRef === null ||
                (status !== "open" && status !== "coalesced")
              ) {
                return yield* Effect.fail(failure("report", "invalid-row"));
              }
              return {
                report_id: reportId,
                case_ref: caseRef,
                status,
              } satisfies CommunityContentReportOutcome;
            }
            const replay = yield* transaction.execute<Row>({
              label: "community-moderation.report-replay",
              text: `SELECT report_id, case_ref, status, request_hash
                       FROM community_content_reports_v2
                      WHERE reporter_user_id = $1
                        AND target_type = $2
                        AND target_resource_id = $3
                        AND idempotency_key = $4
                      FOR UPDATE`,
              values: [input.actor.userId, input.targetType, input.targetId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (stringValue(row, "request_hash") !== input.requestHash) {
                return yield* Effect.fail(
                  failure("report", "idempotency-conflict", input.targetId),
                );
              }
              const reportId = stringValue(row, "report_id");
              const caseRef = stringValue(row, "case_ref");
              const status = stringValue(row, "status");
              if (
                reportId === null ||
                caseRef === null ||
                (status !== "open" && status !== "coalesced")
              ) {
                return yield* Effect.fail(failure("report", "invalid-row"));
              }
              return {
                report_id: reportId,
                case_ref: caseRef,
                status,
              } satisfies CommunityContentReportOutcome;
            }
            const target = yield* transaction.execute<Row>({
              label: "community-moderation.report-target",
              text:
                input.targetType === "post"
                  ? `SELECT post.community_id, submission.submission_id, submission.surface,
                            submission.author_persona_id
                       FROM posts AS post
                       JOIN text_content_submissions AS submission
                         ON submission.community_id = post.community_id
                        AND submission.published_post_id = post.post_id
                      WHERE post.post_id = $1 AND post.status = 'published'
                      FOR UPDATE OF post`
                  : `SELECT comment.community_id, submission.submission_id, submission.surface,
                            submission.author_persona_id
                       FROM comments AS comment
                       JOIN text_content_submissions AS submission
                         ON submission.community_id = comment.community_id
                        AND submission.published_comment_id = comment.comment_id
                      WHERE comment.comment_id = $1 AND comment.status = 'published'
                      FOR UPDATE OF comment`,
              values: [input.targetId],
              readonly: false,
            });
            const row = target.rows.length === 1 ? (target.rows[0] as Row) : null;
            const communityId = row === null ? null : stringValue(row, "community_id");
            const submissionId = row === null ? null : stringValue(row, "submission_id");
            const surface = row === null ? null : stringValue(row, "surface");
            if (
              communityId === null ||
              submissionId === null ||
              !["text_post", "comment", "reply"].includes(surface ?? "")
            ) {
              return yield* Effect.fail(failure("report", "not-found"));
            }
            const membership = yield* transaction.execute<Row>({
              label: "community-moderation.report-membership",
              text: "SELECT active_community_effect($1, $2) AS allowed",
              values: [communityId, input.actor.userId],
              readonly: true,
            });
            if (
              membership.rows.length !== 1 ||
              booleanValue(membership.rows[0] as Row, "allowed") !== true
            ) {
              return yield* Effect.fail(failure("report", "membership-required", submissionId));
            }
            const open = yield* transaction.execute<Row>({
              label: "community-moderation.report-open-case",
              text: `SELECT case_ref
                       FROM community_moderation_cases_v2
                      WHERE submission_id = $1
                        AND visibility = 'owner'
                        AND view_state = 'open'
                      FOR UPDATE`,
              values: [submissionId],
              readonly: false,
            });
            const caseRef =
              open.rows.length === 1
                ? stringValue(open.rows[0] as Row, "case_ref")
                : makeId("case");
            if (caseRef === null || open.rows.length > 1)
              return yield* Effect.fail(failure("report", "invalid-row"));
            const reportStatus =
              open.rows.length === 1 ? ("coalesced" as const) : ("open" as const);
            const now = yield* transaction.execute<Row>({
              label: "community-moderation.report-clock",
              text: "SELECT clock_timestamp() AS now",
              values: [],
              readonly: true,
            });
            const at = isoValue(now.rows[0] as Row, "now");
            if (at === null) return yield* Effect.fail(failure("report", "invalid-row"));
            if (open.rows.length === 0) {
              yield* transaction.execute({
                label: "community-moderation.report-create-case",
                text: `INSERT INTO community_moderation_cases_v2 (
                    case_ref, community_id, submission_id, target_type,
                    target_resource_id, source, visibility, view_state,
                    target_status, case_revision, created_at, updated_at
                  ) VALUES ($1, $2, $3, $4, $5, 'member_report', 'owner',
                    'open', 'published', 1, $6, $6)`,
                values: [caseRef, communityId, submissionId, surface, input.targetId, at],
                readonly: false,
              });
            }
            const reportId = makeId("report");
            yield* transaction.execute({
              label: "community-moderation.report-insert",
              text: `INSERT INTO community_content_reports_v2 (
                  report_id, community_id, submission_id, target_type,
                  target_resource_id, case_ref, reporter_user_id, idempotency_key,
                  request_hash, reason_code, status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              values: [
                reportId,
                communityId,
                submissionId,
                input.targetType,
                input.targetId,
                caseRef,
                input.actor.userId,
                input.idempotencyKey,
                input.requestHash,
                input.reasonCode,
                reportStatus,
                at,
              ],
              readonly: false,
            });
            return {
              report_id: reportId,
              case_ref: caseRef,
              status: reportStatus,
            } satisfies CommunityContentReportOutcome;
          }),
        );
      }),
    );

  const replayLegacyAction: RepositoryService["replayLegacyAction"] = (input) =>
    mapDatabaseFailure(
      "legacy-replay",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.caseRef) ||
          !validId(input.actor.userId) ||
          !validId(input.idempotencyKey) ||
          !HASH.test(input.requestHash)
        ) {
          return yield* Effect.fail(failure("legacy-replay", "constraint"));
        }
        const db = yield* ControlPlaneDb;
        const result = yield* db.execute<Row>({
          label: "community-moderation.legacy-action-replay",
          text: `SELECT action_id, case_ref, action, target_status, request_hash,
                        response_snapshot_bytes, response_snapshot_sha256
                   FROM comment_moderation_actions
                  WHERE case_ref = $1
                    AND actor_user_id = $2
                    AND idempotency_key = $3`,
          values: [input.caseRef, input.actor.userId, input.idempotencyKey],
          readonly: true,
        });
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1)
          return yield* Effect.fail(failure("legacy-replay", "invalid-row"));
        const row = result.rows[0] as Row;
        if (stringValue(row, "request_hash") !== input.requestHash) {
          return yield* Effect.fail(
            failure("legacy-replay", "idempotency-conflict", input.caseRef),
          );
        }
        const actionId = stringValue(row, "action_id");
        const caseRef = stringValue(row, "case_ref");
        const action = stringValue(row, "action") as
          | "approve"
          | "dismiss"
          | "hide"
          | "remove"
          | "restore"
          | null;
        const targetStatus = stringValue(row, "target_status") as
          | "held"
          | "published"
          | "hidden"
          | "removed"
          | null;
        const bytes = row.response_snapshot_bytes;
        const expectedSnapshotHash = stringValue(row, "response_snapshot_sha256");
        if (
          actionId === null ||
          caseRef === null ||
          action === null ||
          targetStatus === null ||
          !(bytes instanceof Uint8Array) ||
          expectedSnapshotHash === null ||
          !HASH.test(expectedSnapshotHash)
        ) {
          return yield* Effect.fail(failure("legacy-replay", "invalid-row"));
        }
        const actualSnapshotHash = Array.from(
          new Uint8Array(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes))),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (actualSnapshotHash !== expectedSnapshotHash) {
          return yield* Effect.fail(failure("legacy-replay", "invalid-row"));
        }
        return {
          action_id: actionId,
          case_ref: caseRef,
          action,
          target_status: targetStatus,
          responseBytes: bytes,
        };
      }),
    );

  const actOnCase: RepositoryService["actOnCase"] = (input) =>
    mapDatabaseFailure(
      "action",
      Effect.gen(function* () {
        if (
          input.actor.kind === "agent" ||
          !validId(input.caseRef) ||
          !validId(input.actor.userId) ||
          !validId(input.idempotencyKey) ||
          !HASH.test(input.requestHash) ||
          !Number.isSafeInteger(input.expectedCaseRevision) ||
          input.expectedCaseRevision < 1 ||
          !ACTIONS.includes(input.action)
        ) {
          return yield* Effect.fail(failure("action", "constraint"));
        }
        const db = yield* ControlPlaneDb;
        return yield* db.withTransaction((transaction) =>
          Effect.gen(function* () {
            yield* transaction.execute({
              label: "community-moderation.action-lock",
              text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
              values: [
                JSON.stringify([
                  "community-moderation-action-v2",
                  input.caseRef,
                  input.actor.userId,
                  input.idempotencyKey,
                ]),
              ],
              readonly: false,
            });
            const replay = yield* transaction.execute<Row>({
              label: "community-moderation.action-replay",
              text: `SELECT action_id, case_ref, action, after_target_status, request_hash
                       FROM community_moderation_actions_v2
                      WHERE case_ref = $1
                        AND actor_user_id = $2
                        AND idempotency_key = $3
                      FOR UPDATE`,
              values: [input.caseRef, input.actor.userId, input.idempotencyKey],
              readonly: false,
            });
            if (replay.rows.length === 1) {
              const row = replay.rows[0] as Row;
              if (stringValue(row, "request_hash") !== input.requestHash) {
                return yield* Effect.fail(failure("action", "idempotency-conflict", input.caseRef));
              }
              const actionId = stringValue(row, "action_id");
              const caseRef = stringValue(row, "case_ref");
              const action = stringValue(row, "action") as Action | null;
              const targetStatus = stringValue(row, "after_target_status") as TargetStatus | null;
              if (
                actionId === null ||
                caseRef === null ||
                action === null ||
                targetStatus === null
              ) {
                return yield* Effect.fail(failure("action", "invalid-row"));
              }
              return {
                version: "moderation-case-action-result-v2" as const,
                action_id: actionId,
                case_ref: caseRef,
                action,
                target_status: targetStatus,
              };
            }
            if (replay.rows.length > 1) return yield* Effect.fail(failure("action", "invalid-row"));
            const cases = yield* transaction.execute<Row>({
              label: "community-moderation.action-case",
              text: `${caseSelect}
                      WHERE moderation_case.case_ref = $1
                        AND moderation_case.visibility = 'owner'
                        AND moderation_case.view_state IN ('open', 'hidden')
                      FOR UPDATE OF moderation_case, submission`,
              values: [input.caseRef],
              readonly: false,
            });
            const row = cases.rows.length === 1 ? (cases.rows[0] as Row) : null;
            if (row === null) return yield* Effect.fail(failure("action", "not-found"));
            const communityId = stringValue(row, "community_id");
            const submissionId = stringValue(row, "submission_id");
            const targetType = stringValue(row, "target_type") as
              | "text_post"
              | "comment"
              | "reply"
              | null;
            const source = stringValue(row, "source") as
              | "automatic"
              | "member_report"
              | "mixed"
              | null;
            const beforeView = stringValue(row, "view_state") as "open" | "hidden" | null;
            const beforeStatus = stringValue(row, "target_status") as TargetStatus | null;
            const rating = (stringValue(row, "resulting_content_rating") ?? "adult_18") as
              | "general"
              | "adult_18";
            const authorRating = stringValue(row, "author_declared_rating") as
              | "general"
              | "adult_18"
              | null;
            const revision = integerValue(row, "case_revision");
            const updatedAt = isoValue(row, "updated_at");
            if (
              communityId === null ||
              submissionId === null ||
              targetType === null ||
              source === null ||
              beforeView === null ||
              beforeStatus === null ||
              revision === null ||
              updatedAt === null ||
              (rating !== "general" && rating !== "adult_18") ||
              (authorRating !== "general" && authorRating !== "adult_18")
            ) {
              return yield* Effect.fail(failure("action", "invalid-row"));
            }
            const ownerAssignmentId = yield* requireOwner(
              transaction,
              "action",
              communityId,
              input.actor.userId,
              "moderation.act",
            );
            if (revision !== input.expectedCaseRevision) {
              return yield* Effect.fail(failure("action", "conflict", input.caseRef));
            }
            const ageCapability = yield* transaction.execute<Row>({
              label: "community-moderation.action-age-capability",
              text: "SELECT current_account_age_capability_v1($1) AS capability",
              values: [input.actor.userId],
              readonly: true,
            });
            const adultCapable =
              ageCapability.rows.length === 1 &&
              stringValue(ageCapability.rows[0] as Row, "capability") === "adult_18";
            const requiresAdultCapability =
              input.action === "approve_as_adult_18" ||
              (rating === "adult_18" && ["dismiss_report", "restore"].includes(input.action));
            if (requiresAdultCapability && !adultCapable) {
              return yield* Effect.fail(failure("action", "conflict", input.caseRef));
            }
            if (
              !permittedActions(source, beforeStatus, rating, adultCapable).includes(input.action)
            ) {
              return yield* Effect.fail(failure("action", "conflict", input.caseRef));
            }
            const afterRating =
              input.action === "approve_as_adult_18" || input.action === "raise_rating_to_adult_18"
                ? "adult_18"
                : rating;
            const transition: { readonly view: ViewState; readonly status: TargetStatus } =
              input.action === "hide"
                ? { view: "hidden", status: "hidden" }
                : input.action === "reject"
                  ? { view: "resolved", status: "blocked" }
                  : { view: "resolved", status: "published" };
            const clock = yield* transaction.execute<Row>({
              label: "community-moderation.action-clock",
              text: "SELECT GREATEST(clock_timestamp(), $1::timestamptz + interval '1 microsecond') AS now",
              values: [updatedAt],
              readonly: true,
            });
            const at = isoValue(clock.rows[0] as Row, "now");
            if (at === null) return yield* Effect.fail(failure("action", "invalid-row"));
            let targetResourceId = stringValue(row, "target_resource_id");
            const submissionActorId = stringValue(row, "actor_user_id");
            const submissionPersonaId = stringValue(row, "author_persona_id");
            const submissionStatus = stringValue(row, "submission_status");
            const submissionKey = stringValue(row, "idempotency_key");
            const submissionHash = stringValue(row, "request_hash");
            const targetPostId = stringValue(row, "target_post_id");
            const targetParentId = stringValue(row, "target_parent_comment_id");
            const platformPolicyRevisionId = stringValue(row, "platform_policy_revision_id");
            const platformPolicyHash = stringValue(row, "platform_policy_hash");
            const communityPolicyRevisionId = stringValue(row, "community_policy_revision_id");
            const communityPolicyHash = stringValue(row, "community_policy_hash");
            const evidenceRef = stringValue(row, "evidence_ref");
            const heldTitle = stringValue(row, "held_title");
            const heldBody = stringValue(row, "held_body");
            if (
              platformPolicyRevisionId === null ||
              platformPolicyHash === null ||
              communityPolicyRevisionId === null ||
              communityPolicyHash === null
            ) {
              return yield* Effect.fail(failure("action", "invalid-row"));
            }
            const personas = yield* transaction.execute<Row>({
              label: "community-moderation.action-presenting-persona",
              text: `SELECT persona_id
                       FROM personas
                      WHERE account_id = $1 AND status = 'active' AND is_first_persona
                      FOR SHARE`,
              values: [input.actor.userId],
              readonly: true,
            });
            const presentingPersonaId =
              personas.rows.length === 1
                ? stringValue(personas.rows[0] as Row, "persona_id")
                : null;
            if (presentingPersonaId === null) {
              return yield* Effect.fail(failure("action", "invalid-row"));
            }

            if (input.action === "approve_as_general" || input.action === "approve_as_adult_18") {
              if (
                submissionStatus !== "manual_review" ||
                submissionActorId === null ||
                submissionPersonaId === null ||
                submissionKey === null ||
                !HASH.test(submissionHash ?? "")
              ) {
                return yield* Effect.fail(failure("action", "invalid-row"));
              }
              const authorEffect = yield* transaction.execute<Row>({
                label: "community-moderation.approve-author-effect",
                text: "SELECT active_community_effect($1, $2) AS allowed",
                values: [communityId, submissionActorId],
                readonly: true,
              });
              if (
                authorEffect.rows.length !== 1 ||
                booleanValue(authorEffect.rows[0] as Row, "allowed") !== true
              ) {
                return yield* Effect.fail(failure("action", "conflict", submissionId));
              }
              if (targetType === "text_post") {
                targetResourceId = makeId("post");
                yield* transaction.execute({
                  label: "community-moderation.approve-post",
                  text: `INSERT INTO posts (
                      community_id, post_id, author_user_id, author_persona_id,
                      post_type, status, visibility, title, body, created_at,
                      updated_at, idempotency_key, idempotency_body_hash,
                      author_declared_rating, content_rating
                    ) VALUES ($1, $2, $3, $4, 'text', 'published', 'public',
                      $5, $6, $7, $7, $8, $9, $10, $11)`,
                  values: [
                    communityId,
                    targetResourceId,
                    submissionActorId,
                    submissionPersonaId,
                    heldTitle,
                    heldBody,
                    at,
                    submissionKey,
                    submissionHash,
                    authorRating,
                    afterRating,
                  ],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "community-moderation.approve-post-feed",
                  text: `INSERT INTO home_feed_projection (
                      community_id, feed_item_id, post_id, rank_score, projected_at
                    ) VALUES ($1, $2, $3, 0, $4)`,
                  values: [communityId, makeId("feed"), targetResourceId, at],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "community-moderation.approve-post-submission",
                  text: `UPDATE text_content_submissions
                            SET status = 'published', public_reason_code = NULL,
                                published_post_id = $3, review_ref = NULL, updated_at = $4,
                                resulting_content_rating = $5
                          WHERE community_id = $1 AND submission_id = $2`,
                  values: [communityId, submissionId, targetResourceId, at, afterRating],
                  readonly: false,
                });
              } else {
                if (targetPostId === null || heldBody === null || heldBody.trim() === "") {
                  return yield* Effect.fail(failure("action", "invalid-row"));
                }
                const parent = yield* transaction.execute<Row>({
                  label: "community-moderation.approve-comment-target",
                  text: `SELECT post.status AS post_status, post.comments_locked,
                                parent.status AS parent_status, parent.depth AS parent_depth
                           FROM posts AS post
                           LEFT JOIN comments AS parent
                             ON parent.community_id = post.community_id
                            AND parent.comment_id = $3
                          WHERE post.community_id = $1 AND post.post_id = $2
                          FOR UPDATE OF post`,
                  values: [communityId, targetPostId, targetParentId],
                  readonly: false,
                });
                const parentRow = parent.rows.length === 1 ? (parent.rows[0] as Row) : null;
                const parentDepth =
                  targetType === "reply" && parentRow !== null
                    ? integerValue(parentRow, "parent_depth")
                    : -1;
                if (
                  parentRow === null ||
                  stringValue(parentRow, "post_status") !== "published" ||
                  booleanValue(parentRow, "comments_locked") === true ||
                  (targetType === "reply" &&
                    (stringValue(parentRow, "parent_status") !== "published" ||
                      parentDepth === null ||
                      parentDepth >= 8))
                ) {
                  return yield* Effect.fail(failure("action", "conflict", submissionId));
                }
                targetResourceId = makeId("comment");
                const depth = targetType === "comment" ? 0 : (parentDepth ?? 0) + 1;
                yield* transaction.execute({
                  label: "community-moderation.approve-comment",
                  text: `INSERT INTO comments (
                      community_id, comment_id, post_id, parent_comment_id,
                      author_user_id, author_persona_id, status, body, created_at,
                      updated_at, idempotency_key, idempotency_body_hash, depth, reply_count
                      , author_declared_rating, content_rating
                    ) VALUES ($1, $2, $3, $4, $5, $6, 'published', $7, $8, $8, $9, $10, $11, 0,
                      $12, $13)`,
                  values: [
                    communityId,
                    targetResourceId,
                    targetPostId,
                    targetParentId,
                    submissionActorId,
                    submissionPersonaId,
                    heldBody,
                    at,
                    submissionKey,
                    submissionHash,
                    depth,
                    authorRating,
                    afterRating,
                  ],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "community-moderation.approve-comment-projection",
                  text: `INSERT INTO comment_publication_projection (
                      community_id, comment_id, post_id, parent_comment_id,
                      author_user_id, author_persona_id, body, depth, status,
                      projected_at, updated_at, content_rating
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published', $9, $9, $10)`,
                  values: [
                    communityId,
                    targetResourceId,
                    targetPostId,
                    targetParentId,
                    submissionActorId,
                    submissionPersonaId,
                    heldBody,
                    depth,
                    at,
                    afterRating,
                  ],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "community-moderation.approve-comment-count",
                  text: "UPDATE posts SET comment_count = comment_count + 1, updated_at = $3 WHERE community_id = $1 AND post_id = $2",
                  values: [communityId, targetPostId, at],
                  readonly: false,
                });
                if (targetParentId !== null) {
                  yield* transaction.execute({
                    label: "community-moderation.approve-reply-count",
                    text: "UPDATE comments SET reply_count = reply_count + 1, updated_at = $3 WHERE community_id = $1 AND comment_id = $2",
                    values: [communityId, targetParentId, at],
                    readonly: false,
                  });
                }
                yield* transaction.execute({
                  label: "community-moderation.approve-comment-submission",
                  text: `UPDATE text_content_submissions
                            SET status = 'published', public_reason_code = NULL,
                                published_comment_id = $3, review_ref = NULL, updated_at = $4,
                                resulting_content_rating = $5
                          WHERE community_id = $1 AND submission_id = $2`,
                  values: [communityId, submissionId, targetResourceId, at, afterRating],
                  readonly: false,
                });
              }
            } else if (input.action === "raise_rating_to_adult_18") {
              if (targetResourceId === null) {
                return yield* Effect.fail(failure("action", "conflict"));
              }
              const raised = yield* transaction.execute<Row>({
                label: "community-moderation.raise-rating",
                text: `SELECT raise_text_rating_with_descendants_v1($1, $2, $3, $4) AS changed`,
                values: [communityId, targetType, targetResourceId, at],
                readonly: false,
              });
              if (
                raised.rows.length !== 1 ||
                integerValue(raised.rows[0] as Row, "changed") === null
              ) {
                return yield* Effect.fail(failure("action", "conflict"));
              }
            } else if (input.action === "reject") {
              yield* transaction.execute({
                label: "community-moderation.reject-submission",
                text: `UPDATE text_content_submissions
                          SET status = 'blocked', public_reason_code = 'policy_violation',
                              published_post_id = NULL, published_comment_id = NULL,
                              review_ref = NULL, updated_at = $3
                        WHERE community_id = $1 AND submission_id = $2
                          AND status = 'manual_review'`,
                values: [communityId, submissionId, at],
                readonly: false,
              });
            } else if (input.action === "hide" || input.action === "restore") {
              if (targetResourceId === null)
                return yield* Effect.fail(failure("action", "conflict"));
              const nextStatus = input.action === "hide" ? "hidden" : "published";
              if (targetType === "text_post") {
                const changed = yield* transaction.execute<Row>({
                  label: "community-moderation.visibility-post",
                  text: `UPDATE posts SET status = $3, updated_at = $4
                          WHERE community_id = $1 AND post_id = $2
                            AND status = $5
                        RETURNING post_id`,
                  values: [communityId, targetResourceId, nextStatus, at, beforeStatus],
                  readonly: false,
                });
                if (changed.rows.length !== 1)
                  return yield* Effect.fail(failure("action", "conflict"));
                if (input.action === "hide") {
                  yield* transaction.execute({
                    label: "community-moderation.hide-post-feed",
                    text: "DELETE FROM home_feed_projection WHERE community_id = $1 AND post_id = $2",
                    values: [communityId, targetResourceId],
                    readonly: false,
                  });
                } else {
                  yield* transaction.execute({
                    label: "community-moderation.restore-post-feed",
                    text: `INSERT INTO home_feed_projection (
                        community_id, feed_item_id, post_id, rank_score, projected_at
                      ) VALUES ($1, $2, $3, 0, $4) ON CONFLICT DO NOTHING`,
                    values: [communityId, makeId("feed"), targetResourceId, at],
                    readonly: false,
                  });
                }
              } else {
                const changed = yield* transaction.execute<Row>({
                  label: "community-moderation.visibility-comment",
                  text: `UPDATE comments SET status = $3, updated_at = $4
                          WHERE community_id = $1 AND comment_id = $2
                            AND status = $5
                        RETURNING post_id, parent_comment_id`,
                  values: [communityId, targetResourceId, nextStatus, at, beforeStatus],
                  readonly: false,
                });
                const changedRow = changed.rows.length === 1 ? (changed.rows[0] as Row) : null;
                if (changedRow === null) return yield* Effect.fail(failure("action", "conflict"));
                const postId = stringValue(changedRow, "post_id");
                if (postId === null) return yield* Effect.fail(failure("action", "conflict"));
                yield* transaction.execute({
                  label: "community-moderation.visibility-comment-projection",
                  text: "UPDATE comment_publication_projection SET status = $3, updated_at = $4 WHERE community_id = $1 AND comment_id = $2",
                  values: [communityId, targetResourceId, nextStatus, at],
                  readonly: false,
                });
                const delta = input.action === "hide" ? -1 : 1;
                yield* transaction.execute({
                  label: "community-moderation.visibility-comment-count",
                  text: "UPDATE posts SET comment_count = GREATEST(comment_count + $3, 0), updated_at = $4 WHERE community_id = $1 AND post_id = $2",
                  values: [communityId, postId, delta, at],
                  readonly: false,
                });
                const parentId = stringValue(changedRow, "parent_comment_id");
                if (parentId !== null) {
                  yield* transaction.execute({
                    label: "community-moderation.visibility-reply-count",
                    text: "UPDATE comments SET reply_count = GREATEST(reply_count + $3, 0), updated_at = $4 WHERE community_id = $1 AND comment_id = $2",
                    values: [communityId, parentId, delta, at],
                    readonly: false,
                  });
                }
              }
            }

            const actionId = makeId("action");
            const response = {
              version: "moderation-case-action-result-v2" as const,
              action_id: actionId,
              case_ref: input.caseRef,
              action: input.action,
              target_status: transition.status,
            };
            const responseBytes = new TextEncoder().encode(JSON.stringify(response));
            yield* transaction.execute({
              label: "community-moderation.action-insert",
              text: `INSERT INTO community_moderation_actions_v2 (
                  action_id, community_id, case_ref, actor_user_id,
                  owner_role_assignment_id, presenting_persona_id,
                  idempotency_key, request_hash,
                  expected_case_revision, action, before_view_state,
                  after_view_state, before_target_status, after_target_status,
                  before_rating, after_rating, platform_policy_revision_id,
                  platform_policy_hash, community_policy_revision_id,
                  community_policy_hash, evidence_ref, resolved_age_capability,
                  response_snapshot_bytes,
                  response_snapshot_sha256, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  $13, $14, $15, $16, $17, $18, $19, $20, $21,
                  $22, $23, encode(sha256($23), 'hex'), $24)`,
              values: [
                actionId,
                communityId,
                input.caseRef,
                input.actor.userId,
                ownerAssignmentId,
                presentingPersonaId,
                input.idempotencyKey,
                input.requestHash,
                revision,
                input.action,
                beforeView,
                transition.view,
                beforeStatus,
                transition.status,
                rating,
                afterRating,
                platformPolicyRevisionId,
                platformPolicyHash,
                communityPolicyRevisionId,
                communityPolicyHash,
                evidenceRef,
                adultCapable ? "adult_18" : "general",
                responseBytes,
                at,
              ],
              readonly: false,
            });
            if (input.action === "raise_rating_to_adult_18") {
              yield* transaction.execute({
                label: "community-moderation.raise-submission-rating",
                text: `UPDATE text_content_submissions
                          SET resulting_content_rating = 'adult_18', updated_at = $3
                        WHERE community_id = $1 AND submission_id = $2`,
                values: [communityId, submissionId, at],
                readonly: false,
              });
            }
            yield* transaction.execute({
              label: "community-moderation.action-update-case",
              text: `UPDATE community_moderation_cases_v2
                        SET target_resource_id = $3, view_state = $4,
                            target_status = $5, case_revision = case_revision + 1,
                            last_action_id = $6, updated_at = $7
                      WHERE community_id = $1 AND case_ref = $2`,
              values: [
                communityId,
                input.caseRef,
                targetResourceId,
                transition.view,
                transition.status,
                actionId,
                at,
              ],
              readonly: false,
            });
            const legacyStatus =
              input.action === "reject" || input.action === "hide"
                ? "blocked"
                : input.action === "dismiss_report"
                  ? "dismissed"
                  : "approved";
            if (source === "automatic" && beforeView === "open") {
              yield* transaction.execute({
                label: "community-moderation.action-update-text-case",
                text: `UPDATE text_moderation_cases
                          SET status = $3, resolved_by_user_id = $4, updated_at = $5
                        WHERE community_id = $1 AND case_id = $2 AND status = 'open'`,
                values: [communityId, input.caseRef, legacyStatus, input.actor.userId, at],
                readonly: false,
              });
            }
            if (beforeView === "open") {
              yield* transaction.execute({
                label: "community-moderation.action-update-comment-case",
                text: `UPDATE comment_moderation_cases
                          SET status = $3, resolved_by_user_id = $4, updated_at = $5
                        WHERE community_id = $1 AND case_ref = $2 AND status = 'open'`,
                values: [communityId, input.caseRef, legacyStatus, input.actor.userId, at],
                readonly: false,
              });
            }
            return response;
          }),
        );
      }),
    );

  return {
    getCapabilities,
    listCases,
    getCase,
    getPolicy,
    updatePolicy,
    reportTarget,
    replayLegacyAction,
    actOnCase,
  };
}

export function makeControlPlaneCommunityModerationStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): CommunityModerationStoreService {
  const repository = makeControlPlaneCommunityModerationRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  return {
    getCapabilities: (input) => provide(repository.getCapabilities(input)),
    listCases: (input) => provide(repository.listCases(input)),
    getCase: (input) => provide(repository.getCase(input)),
    getPolicy: (input) => provide(repository.getPolicy(input)),
    updatePolicy: (input) => provide(repository.updatePolicy(input)),
    reportTarget: (input) => provide(repository.reportTarget(input)),
    replayLegacyAction: (input) => provide(repository.replayLegacyAction(input)),
    actOnCase: (input) => provide(repository.actOnCase(input)),
  };
}
