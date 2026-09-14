import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type HandleNationalityAuthoringStore,
} from "@pirate/application";
import {
  compileNationalityPolicy,
  handleNationalityAuthoringReference,
  handleNationalityPolicyAuthoringRequestHash,
  handleNationalityQualificationRefFromPolicy,
  type NationalityPolicy,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";
import { handleNationalityPolicyFromRow } from "./handle-qualification-policy.ts";
import {
  advisoryLock,
  instant,
  mapped,
  one,
  type Row,
  reject,
  storage,
  text,
} from "./handle-sales-internals.ts";
import type { NationalityAuthoring } from "./nationality-authoring.ts";

const endpoint = "/communities/:communityId/handle-nationality-qualification-policies";
type CreateInput = Parameters<HandleNationalityAuthoringStore["createPolicy"]>[0];

const requireAuthority = (
  transaction: ControlPlaneTransaction,
  input: { accountId: string; communityId: string },
) =>
  Effect.gen(function* () {
    const authority = yield* transaction.execute<Row>({
      label: "handle-nationality.authority.read",
      text: `SELECT grant_id FROM community_handle_sales_authority_grants AS authority
           JOIN communities AS community ON community.community_id=authority.community_id
           WHERE authority.community_id=$1 AND authority.principal_account_id=$2
             AND authority.authority='manage_handle_sales' AND authority.status='active'
             AND community.status='active' FOR SHARE OF authority,community`,
      values: [input.communityId, input.accountId],
      readonly: false,
    });
    if (authority.rows.length === 0) return yield* reject("offering_unavailable");
  });

const context = (authoring: NationalityAuthoring | null) =>
  Effect.try({
    try: () => {
      if (authoring === null) throw new Error("disabled");
      return { authoring, reference: handleNationalityAuthoringReference(authoring) };
    },
    catch: () => reject("offering_unavailable"),
  });

const compile = (
  input: CreateInput,
  authoring: Pick<NationalityPolicy, "policy_revision" | "provider_bindings" | "evidence_lifetime">,
) =>
  Effect.try({
    try: () => {
      const result = compileNationalityPolicy({
        policy_revision: authoring.policy_revision,
        evidence_lifetime: authoring.evidence_lifetime,
        provider_bindings: authoring.provider_bindings,
        allowed_countries: input.allowedCountries,
      });
      if (result.kind !== "compiled" || result.policy.evidence_lifetime.kind !== "max_age_seconds")
        throw new Error("Invalid policy");
      const requestHash = handleNationalityPolicyAuthoringRequestHash({
        actor_account_id: input.accountId,
        community_id: input.communityId,
        idempotency_key: input.idempotencyKey,
        authoring_reference: input.authoringReference,
        requirement: result.policy.requirement,
      });
      return { policy: result.policy, requestHash };
    },
    catch: () => reject("offering_unavailable"),
  });

export function makeControlPlaneHandleNationalityAuthoringStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  authoring: NationalityAuthoring | null,
): HandleNationalityAuthoringStore {
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  return {
    getContext: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* mapped(
            db.withTransaction((transaction) =>
              Effect.gen(function* () {
                yield* requireAuthority(transaction, input);
                const resolved = yield* context(authoring);
                return {
                  kind: "nationality_authoring_context_v1" as const,
                  community_id: input.communityId,
                  authoring_reference: resolved.reference,
                  policy_revision: resolved.authoring.policy_revision,
                  lifetime: resolved.authoring.evidence_lifetime,
                  accepted_provider_ids: ["self.pass", "zkpassport"] as const,
                };
              }),
            ),
          );
        }),
      ),
    createPolicy: (input) =>
      provide(
        Effect.gen(function* () {
          const db = yield* ControlPlaneDb;
          return yield* mapped(
            db.withTransaction((transaction) =>
              Effect.gen(function* () {
                yield* requireAuthority(transaction, input);
                yield* advisoryLock(
                  transaction,
                  18001,
                  [input.accountId, endpoint, input.idempotencyKey],
                  "handle-nationality.authoring.idempotency-lock",
                );
                const replay = yield* transaction.execute<Row>({
                  label: "handle-nationality.authoring.replay.read",
                  text: `SELECT action.request_hash AS action_request_hash, action.community_id AS action_community_id, policy.*
                 FROM handle_nationality_policy_actions AS action
                 JOIN handle_qualification_policy_revisions AS policy
                   ON policy.policy_id=action.policy_id AND policy.policy_revision=action.policy_revision
                 WHERE action.actor_account_id=$1 AND action.endpoint_template=$2 AND action.idempotency_key=$3
                 FOR SHARE OF action,policy`,
                  values: [input.accountId, endpoint, input.idempotencyKey],
                  readonly: false,
                });
                if (replay.rows[0] !== undefined) {
                  const row = replay.rows[0];
                  const policy = yield* Effect.try({
                    try: () => handleNationalityPolicyFromRow(row),
                    catch: () => storage("invalid-row"),
                  });
                  const request = yield* compile(input, policy);
                  if (
                    text(row, "action_community_id") !== input.communityId ||
                    text(row, "action_request_hash") !== request.requestHash
                  )
                    return yield* reject("idempotency_conflict");
                  return {
                    kind: "nationality_policy_authored_v1" as const,
                    request_hash: request.requestHash,
                    qualification_policy: handleNationalityQualificationRefFromPolicy(
                      text(row, "policy_id"),
                      policy,
                    ),
                    created_at: instant(row.created_at),
                    replayed: true,
                  };
                }
                const resolved = yield* context(authoring);
                if (input.authoringReference !== resolved.reference)
                  return yield* reject("offering_unavailable", true);
                const { policy, requestHash } = yield* compile(input, resolved.authoring);
                const clock = yield* transaction.execute<Row>({
                  label: "handle-nationality.authoring.clock",
                  text: "SELECT clock_timestamp() AS database_now",
                  values: [],
                  readonly: true,
                });
                const now = instant(one(clock.rows, "database clock").database_now);
                yield* transaction.execute({
                  label: "handle-nationality.authoring.policy.insert",
                  text: `INSERT INTO handle_qualification_policy_revisions (
            policy_id,policy_revision,community_id,policy_kind,request_hash,policy_hash,
            requirement_kind,status,created_by_account_id,created_at,nationality_policy
          ) VALUES ($1,$2,$3,'curated_nationality_v1',$4,$5,'nationality_allowed_v1','active',$6,$7::timestamptz,$8::jsonb)`,
                  values: [
                    input.policyId,
                    policy.policy_revision,
                    input.communityId,
                    requestHash,
                    policy.policy_hash,
                    input.accountId,
                    now,
                    JSON.stringify(policy),
                  ],
                  readonly: false,
                });
                yield* transaction.execute({
                  label: "handle-nationality.authoring.action.insert",
                  text: `INSERT INTO handle_nationality_policy_actions (
            action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
            request_hash,authoring_reference,policy_id,policy_revision,committed_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
                  values: [
                    input.actionId,
                    input.accountId,
                    input.communityId,
                    endpoint,
                    input.idempotencyKey,
                    requestHash,
                    resolved.reference,
                    input.policyId,
                    policy.policy_revision,
                    now,
                  ],
                  readonly: false,
                });
                return {
                  kind: "nationality_policy_authored_v1" as const,
                  request_hash: requestHash,
                  qualification_policy: handleNationalityQualificationRefFromPolicy(
                    input.policyId,
                    policy,
                  ),
                  created_at: now,
                  replayed: false,
                };
              }),
            ),
          );
        }),
      ),
  };
}
