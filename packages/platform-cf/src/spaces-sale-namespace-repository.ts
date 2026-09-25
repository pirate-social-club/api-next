import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  type SpacesSaleNamespaceCandidateReadinessV1,
  SpacesSaleNamespaceNotReady,
  type SpacesSaleNamespaceStore,
} from "@pirate/application";
import type { SpacesNetworkV1, SpacesSaleNamespaceActivationV1 } from "@pirate/contracts";
import {
  classifySpacesAuthorityObservationV1,
  deriveSpacesSaleReadinessV1,
  handleSpacesSaleNamespaceActivationHash,
  type SpacesAuthorityDriftV1,
  type SpacesSaleReadinessFactsV1,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";
import {
  advisoryLock,
  boolean,
  instant,
  integer,
  mapped,
  one,
  type Row,
  reject,
  storage,
  text,
} from "./handle-sales-internals.ts";

/**
 * Native Spaces sale-namespace activation store (spec 012 §5.3.13.3 and
 * §5.3.13.4). The database re-checks every transition; this store resolves
 * the server-owned facts, derives readiness in the ratified reason order, and
 * suspends an activation only when a fresh observation confirms authority
 * loss. It is not composed into any Worker while the Spaces driver is
 * disabled.
 */

type CreateInput = Parameters<SpacesSaleNamespaceStore["createSaleNamespace"]>[0];
type ReviseInput = Parameters<SpacesSaleNamespaceStore["reviseSaleNamespace"]>[0];
type RootObservationInput = Parameters<SpacesSaleNamespaceStore["recordRootObservation"]>[0];

const CREATE_ENDPOINT = "/communities/:communityId/handle-sale-namespaces";
const REVISE_ENDPOINT = "/communities/:communityId/handle-sale-namespaces/:activationId/revisions";

const requestHash = (domain: string, value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify([domain, value]))
    .digest("hex");

const network = (row: Row, key: string): SpacesNetworkV1 => {
  const value = text(row, key);
  if (value !== "mainnet" && value !== "testnet4" && value !== "regtest") {
    throw new Error(`invalid ${key}`);
  }
  return value;
};

const nullableInstant = (value: unknown): string | null => (value === null ? null : instant(value));

/** Decodes only the checked Spaces shape; an HNS row is never read as Spaces. */
const spacesActivationFromRow = (row: Row): SpacesSaleNamespaceActivationV1 => {
  if (
    row.family !== "spaces" ||
    row.spaces_operator_assignment_kind !== "spaces_operator_assignment_v1" ||
    row.spaces_operator_funding_terms_kind !== "spaces_operator_funding_confirm_v1" ||
    row.spaces_operator_funding_terms_confirmed !== true
  ) {
    throw new Error("invalid Spaces sale-namespace activation row");
  }
  return {
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
    sale_namespace_activation_hash: text(row, "sale_namespace_activation_hash"),
    community_id: text(row, "community_id"),
    family: "spaces",
    network: network(row, "spaces_network"),
    canonical_root: text(row, "canonical_root"),
    display_root: text(row, "display_root"),
    namespace_authority: {
      kind: "verified_namespace_v1",
      namespace_authority_reference: text(row, "spaces_namespace_authority_reference"),
      namespace_authority_generation: integer(row, "spaces_namespace_authority_generation"),
    },
    operator: {
      kind: "spaces_operator_assignment_v1",
      operator_assignment_id: text(row, "spaces_operator_assignment_id"),
      operator_assignment_generation: integer(row, "spaces_operator_assignment_generation"),
    },
    operator_funding_terms: { kind: "spaces_operator_funding_confirm_v1", confirmed: true },
    status: text(row, "status") as SpacesSaleNamespaceActivationV1["status"],
    created_at: instant(row.created_at),
    activated_at: nullableInstant(row.activated_at),
    suspended_at: nullableInstant(row.suspended_at),
    revoked_at: nullableInstant(row.revoked_at),
  };
};

const factsFromRow = (row: Row): SpacesSaleReadinessFactsV1 => ({
  namespace_authority_current: boolean(row, "namespace_authority_current"),
  owner_challenge_current: boolean(row, "owner_challenge_current"),
  anchor_covers_root_outpoint: boolean(row, "anchor_covers_root_outpoint"),
  publication_verified: boolean(row, "publication_verified"),
  delegation_observed: boolean(row, "delegation_observed"),
  operator_capability_observed: boolean(row, "operator_capability_observed"),
  commitment_history_verified: boolean(row, "commitment_history_verified"),
  driver_enabled: boolean(row, "driver_enabled"),
});

const decoded = <A>(decode: () => A) =>
  Effect.try({ try: decode, catch: () => storage("invalid-row") });

const databaseNow = (transaction: ControlPlaneTransaction) =>
  Effect.gen(function* () {
    const clock = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.database-clock.read",
      text: "SELECT clock_timestamp() AS database_now",
      values: [],
      readonly: false,
    });
    return yield* decoded(() => instant(one(clock.rows, "database clock").database_now));
  });

const configuredNetwork = (transaction: ControlPlaneTransaction) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.network.read",
      text: `SELECT network FROM spaces_network_configuration
              WHERE configuration_key='spaces_network_v1' FOR SHARE`,
      values: [],
      readonly: false,
    });
    const row = result.rows[0];
    return row === undefined ? null : yield* decoded(() => network(row, "network"));
  });

const salesAuthority = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ communityId: string; accountId: string }>,
) =>
  transaction.execute<Row>({
    label: "spaces-sale-namespace.authority.read",
    text: `SELECT authority_grant.grant_id
             FROM communities AS community
             JOIN community_handle_sales_authority_grants AS authority_grant
               ON authority_grant.community_id=community.community_id
              AND authority_grant.principal_account_id=$2
              AND authority_grant.authority='manage_handle_sales'
              AND authority_grant.status='active'
            WHERE community.community_id=$1 AND community.status='active'
            FOR SHARE OF community,authority_grant`,
    values: [input.communityId, input.accountId],
    readonly: false,
  });

const readFacts = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    network: SpacesNetworkV1;
    canonicalRoot: string;
    communityId: string;
    namespaceAuthorityReference: string;
    namespaceAuthorityGeneration: number;
    operatorAssignmentId: string | null;
    operatorAssignmentGeneration: number | null;
    now: string;
  }>,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.readiness.read",
      text: `SELECT * FROM spaces_sale_namespace_readiness_facts_v1(
               $1,$2,$3,$4,$5,$6,$7,$8::timestamptz
             )`,
      values: [
        input.network,
        input.canonicalRoot,
        input.communityId,
        input.namespaceAuthorityReference,
        input.namespaceAuthorityGeneration,
        input.operatorAssignmentId,
        input.operatorAssignmentGeneration,
        input.now,
      ],
      readonly: false,
    });
    const facts = yield* decoded(() => factsFromRow(one(result.rows, "readiness facts")));
    return { facts, readiness: deriveSpacesSaleReadinessV1(facts) };
  });

const readActivation = (
  transaction: ControlPlaneTransaction,
  activationId: string,
  generation: number,
) =>
  Effect.gen(function* () {
    const result = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.activation.read",
      text: `SELECT * FROM community_handle_sale_namespace_activation_revisions
              WHERE sale_namespace_activation_id=$1 AND sale_namespace_activation_generation=$2`,
      values: [activationId, generation],
      readonly: false,
    });
    return yield* decoded(() => spacesActivationFromRow(one(result.rows, "Spaces activation")));
  });

const readCurrentActivation = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ activationId: string; communityId: string }>,
  lock: boolean,
) =>
  transaction.execute<Row>({
    label: lock
      ? "spaces-sale-namespace.activation.current.lock"
      : "spaces-sale-namespace.activation.current.read",
    text: `SELECT revision.*
             FROM community_handle_sale_namespace_activation_current AS current_activation
             JOIN community_handle_sale_namespace_activation_revisions AS revision
               ON revision.sale_namespace_activation_id=current_activation.sale_namespace_activation_id
              AND revision.sale_namespace_activation_generation=current_activation.current_generation
            WHERE current_activation.sale_namespace_activation_id=$1
              AND revision.community_id=$2
              AND revision.family='spaces'
            ${lock ? "FOR UPDATE OF current_activation" : ""}`,
    values: [input.activationId, input.communityId],
    readonly: !lock,
  });

const replay = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{ accountId: string; idempotencyKey: string }>,
  endpoint: string,
) =>
  transaction.execute<Row>({
    label: "spaces-sale-namespace.replay.read",
    text: `SELECT * FROM community_handle_sale_namespace_activation_actions
            WHERE actor_account_id=$1 AND endpoint_template=$2 AND idempotency_key=$3
            FOR UPDATE`,
    values: [input.accountId, endpoint, input.idempotencyKey],
    readonly: false,
  });

/**
 * Resolves the evidence and operator assignment a command names. Stale
 * generations are retryable; evidence naming another controlling account is
 * an authority refusal (§5.3.13.3 item 1).
 */
const resolveAuthority = (
  transaction: ControlPlaneTransaction,
  input: Readonly<{
    network: SpacesNetworkV1;
    accountId: string;
    communityId: string;
    namespaceAuthorityReference: string;
    expectedNamespaceAuthorityGeneration: number;
    operatorAssignmentId: string;
    expectedOperatorAssignmentGeneration: number;
  }>,
) =>
  Effect.gen(function* () {
    const evidence = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.evidence.read",
      text: `SELECT evidence.*,
                    evidence.namespace_authority_generation = (
                      SELECT max(latest.namespace_authority_generation)
                        FROM spaces_namespace_authority_evidence AS latest
                       WHERE latest.namespace_authority_reference=evidence.namespace_authority_reference
                    ) AS is_current
               FROM spaces_namespace_authority_evidence AS evidence
              WHERE evidence.namespace_authority_reference=$1
                AND evidence.namespace_authority_generation=$2
                AND evidence.network=$3
              FOR SHARE`,
      values: [
        input.namespaceAuthorityReference,
        input.expectedNamespaceAuthorityGeneration,
        input.network,
      ],
      readonly: false,
    });
    const evidenceRow = evidence.rows[0];
    if (evidenceRow === undefined || evidenceRow.is_current !== true) {
      return yield* reject("sale_namespace_inactive", true);
    }
    if (evidenceRow.controlling_account_id !== input.accountId) {
      return yield* reject("offering_unavailable");
    }
    const assignment = yield* transaction.execute<Row>({
      label: "spaces-sale-namespace.assignment.read",
      text: `SELECT revision.*
               FROM spaces_operator_assignment_current AS current_assignment
               JOIN spaces_operator_assignment_revisions AS revision
                 ON revision.operator_assignment_id=current_assignment.operator_assignment_id
                AND revision.operator_assignment_generation=current_assignment.current_generation
              WHERE current_assignment.operator_assignment_id=$1
                AND current_assignment.current_generation=$2
                AND revision.status='active'
                AND revision.network=$3
                AND revision.canonical_root=$4
              FOR SHARE OF current_assignment`,
      values: [
        input.operatorAssignmentId,
        input.expectedOperatorAssignmentGeneration,
        input.network,
        evidenceRow.canonical_root,
      ],
      readonly: false,
    });
    if (assignment.rows[0] === undefined) return yield* reject("sale_namespace_inactive", true);
    return yield* decoded(() => ({
      canonicalRoot: text(evidenceRow, "canonical_root"),
      displayRoot: text(evidenceRow, "display_root"),
      evidenceCommunityId: text(evidenceRow, "community_id"),
    }));
  });

const requireReady = (
  transaction: ControlPlaneTransaction,
  input: Parameters<typeof readFacts>[1],
) =>
  Effect.gen(function* () {
    const { readiness } = yield* readFacts(transaction, input);
    if (readiness.kind === "not_ready_v1") {
      return yield* new SpacesSaleNamespaceNotReady({ reason: readiness.reason });
    }
  });

const insertRevision = (
  transaction: ControlPlaneTransaction,
  revision: Readonly<{
    activationId: string;
    generation: number;
    hash: string;
    communityId: string;
    canonicalRoot: string;
    displayRoot: string;
    network: SpacesNetworkV1;
    namespaceAuthorityReference: string;
    namespaceAuthorityGeneration: number;
    operatorAssignmentId: string;
    operatorAssignmentGeneration: number;
    status: SpacesSaleNamespaceActivationV1["status"];
    reasonCode: string | null;
    actorAccountId: string;
    authorityGrantId: string;
    createdAt: string;
    activatedAt: string | null;
    suspendedAt: string | null;
    revokedAt: string | null;
    recordedAt: string;
  }>,
) =>
  transaction.execute({
    label: "spaces-sale-namespace.revision.insert",
    text: `INSERT INTO community_handle_sale_namespace_activation_revisions (
             sale_namespace_activation_id,sale_namespace_activation_generation,
             sale_namespace_activation_hash,community_id,family,canonical_root,display_root,
             namespace_authority_kind,spaces_network,spaces_namespace_authority_reference,
             spaces_namespace_authority_generation,spaces_operator_assignment_kind,
             spaces_operator_assignment_id,spaces_operator_assignment_generation,
             spaces_operator_funding_terms_kind,spaces_operator_funding_terms_confirmed,
             status,reason_code,actor_account_id,authority_grant_id,created_at,activated_at,
             suspended_at,revoked_at,recorded_at
           ) VALUES (
             $1,$2,$3,$4,'spaces',$5,$6,'verified_namespace_v1',$7,$8,$9,
             'spaces_operator_assignment_v1',$10,$11,'spaces_operator_funding_confirm_v1',TRUE,
             $12,$13,$14,$15,$16::timestamptz,$17::timestamptz,$18::timestamptz,
             $19::timestamptz,$20::timestamptz
           )`,
    values: [
      revision.activationId,
      revision.generation,
      revision.hash,
      revision.communityId,
      revision.canonicalRoot,
      revision.displayRoot,
      revision.network,
      revision.namespaceAuthorityReference,
      revision.namespaceAuthorityGeneration,
      revision.operatorAssignmentId,
      revision.operatorAssignmentGeneration,
      revision.status,
      revision.reasonCode,
      revision.actorAccountId,
      revision.authorityGrantId,
      revision.createdAt,
      revision.activatedAt,
      revision.suspendedAt,
      revision.revokedAt,
      revision.recordedAt,
    ],
    readonly: false,
  });

const insertAction = (
  transaction: ControlPlaneTransaction,
  action: Readonly<{
    actionId: string;
    accountId: string;
    communityId: string;
    endpoint: string;
    idempotencyKey: string;
    requestHash: string;
    activationId: string;
    expectedGeneration: number;
    resultHash: string;
    committedAt: string;
  }>,
) =>
  transaction.execute({
    label: "spaces-sale-namespace.action.insert",
    text: `INSERT INTO community_handle_sale_namespace_activation_actions (
             action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
             request_hash,sale_namespace_activation_id,expected_activation_generation,
             result_activation_generation,result_activation_hash,committed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
    values: [
      action.actionId,
      action.accountId,
      action.communityId,
      action.endpoint,
      action.idempotencyKey,
      action.requestHash,
      action.activationId,
      action.expectedGeneration,
      action.expectedGeneration + 1,
      action.resultHash,
      action.committedAt,
    ],
    readonly: false,
  });

const activationHash = (
  activation: Readonly<{
    activationId: string;
    generation: number;
    communityId: string;
    network: SpacesNetworkV1;
    canonicalRoot: string;
    namespaceAuthorityReference: string;
    namespaceAuthorityGeneration: number;
    operatorAssignmentId: string;
    operatorAssignmentGeneration: number;
  }>,
) =>
  Effect.try({
    try: () =>
      handleSpacesSaleNamespaceActivationHash({
        sale_namespace_activation_id: activation.activationId,
        sale_namespace_activation_generation: activation.generation,
        community_id: activation.communityId,
        network: activation.network,
        canonical_root: activation.canonicalRoot,
        namespace_authority_reference: activation.namespaceAuthorityReference,
        namespace_authority_generation: activation.namespaceAuthorityGeneration,
        operator_assignment_id: activation.operatorAssignmentId,
        operator_assignment_generation: activation.operatorAssignmentGeneration,
        operator_funding_terms_confirmed: true,
      }).sha256,
    catch: () => reject("sale_namespace_inactive"),
  });

const commandHash = (domain: string, input: CreateInput | ReviseInput, extra: object = {}) =>
  requestHash(domain, {
    account_id: input.accountId,
    community_id: input.communityId,
    idempotency_key: input.idempotencyKey,
    namespace_authority_reference: input.namespaceAuthorityReference,
    expected_namespace_authority_generation: input.expectedNamespaceAuthorityGeneration,
    operator_assignment_id: input.operatorAssignmentId,
    expected_operator_assignment_generation: input.expectedOperatorAssignmentGeneration,
    operator_funding_terms_confirmed: input.operatorFundingTermsConfirmed,
    ...extra,
  });

const replayed = (
  transaction: ControlPlaneTransaction,
  row: Row,
  expected: Readonly<{ hash: string; communityId: string }>,
) =>
  Effect.gen(function* () {
    if (row.request_hash !== expected.hash || row.community_id !== expected.communityId) {
      return yield* reject("idempotency_conflict");
    }
    const activation = yield* readActivation(
      transaction,
      yield* decoded(() => text(row, "sale_namespace_activation_id")),
      yield* decoded(() => integer(row, "result_activation_generation")),
    );
    return { activation, replayed: true };
  });

export function makeControlPlaneSpacesSaleNamespaceRepository() {
  return {
    readCandidateReadiness: (
      input: Parameters<SpacesSaleNamespaceStore["readCandidateReadiness"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const authority = yield* salesAuthority(transaction, input);
              if (authority.rows[0] === undefined) return null;
              const configured = yield* configuredNetwork(transaction);
              if (configured === null) return null;
              const evidence = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.candidate.evidence.read",
                text: `SELECT evidence.*
                         FROM spaces_namespace_authority_evidence AS evidence
                        WHERE evidence.network=$1 AND evidence.canonical_root=$2
                        ORDER BY evidence.namespace_authority_generation DESC
                        LIMIT 1`,
                values: [configured, input.canonicalRoot],
                readonly: false,
              });
              const evidenceRow = evidence.rows[0];
              if (evidenceRow === undefined) return null;
              const assignment = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.candidate.assignment.read",
                text: `SELECT operator_assignment_id,current_generation
                         FROM spaces_operator_assignment_current
                        WHERE network=$1 AND canonical_root=$2 AND status='active'`,
                values: [configured, input.canonicalRoot],
                readonly: false,
              });
              const assignmentRow = assignment.rows[0];
              const identity = yield* decoded(() => ({
                reference: text(evidenceRow, "namespace_authority_reference"),
                generation: integer(evidenceRow, "namespace_authority_generation"),
                displayRoot: text(evidenceRow, "display_root"),
                assignment:
                  assignmentRow === undefined
                    ? null
                    : {
                        operator_assignment_id: text(assignmentRow, "operator_assignment_id"),
                        operator_assignment_generation: integer(
                          assignmentRow,
                          "current_generation",
                        ),
                      },
              }));
              const { facts, readiness } = yield* readFacts(transaction, {
                network: configured,
                canonicalRoot: input.canonicalRoot,
                communityId: input.communityId,
                namespaceAuthorityReference: identity.reference,
                namespaceAuthorityGeneration: identity.generation,
                operatorAssignmentId: identity.assignment?.operator_assignment_id ?? null,
                operatorAssignmentGeneration:
                  identity.assignment?.operator_assignment_generation ?? null,
                now: yield* databaseNow(transaction),
              });
              return {
                network: configured,
                canonical_root: input.canonicalRoot,
                display_root: identity.displayRoot,
                namespace_authority_reference: identity.reference,
                namespace_authority_generation: identity.generation,
                operator_assignment: identity.assignment,
                facts,
                readiness,
              } satisfies SpacesSaleNamespaceCandidateReadinessV1;
            }),
          ),
        );
      }),

    createSaleNamespace: (input: CreateInput) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const hash = commandHash(
                "pirate-handle-spaces-sale-namespace-create-request-v1",
                input,
              );
              const prior = yield* replay(transaction, input, CREATE_ENDPOINT);
              if (prior.rows[0] !== undefined) {
                return yield* replayed(transaction, prior.rows[0], {
                  hash,
                  communityId: input.communityId,
                });
              }
              if (input.operatorFundingTermsConfirmed !== true) {
                return yield* reject("offering_unavailable");
              }
              const authority = yield* salesAuthority(transaction, input);
              const grant = authority.rows[0];
              if (grant === undefined) return yield* reject("offering_unavailable");
              const configured = yield* configuredNetwork(transaction);
              if (configured === null) return yield* reject("sale_namespace_inactive", true);
              const resolved = yield* resolveAuthority(transaction, {
                ...input,
                network: configured,
              });
              yield* advisoryLock(
                transaction,
                53_001,
                ["spaces", resolved.canonicalRoot],
                "spaces-sale-namespace.root.lock",
              );
              const existing = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.root.read",
                text: `SELECT sale_namespace_activation_id
                         FROM community_handle_sale_namespace_activation_current
                        WHERE family='spaces' AND canonical_root=$1`,
                values: [resolved.canonicalRoot],
                readonly: false,
              });
              if (existing.rows[0] !== undefined) {
                return yield* reject("sale_namespace_inactive");
              }
              const now = yield* databaseNow(transaction);
              yield* requireReady(transaction, {
                network: configured,
                canonicalRoot: resolved.canonicalRoot,
                communityId: input.communityId,
                namespaceAuthorityReference: input.namespaceAuthorityReference,
                namespaceAuthorityGeneration: input.expectedNamespaceAuthorityGeneration,
                operatorAssignmentId: input.operatorAssignmentId,
                operatorAssignmentGeneration: input.expectedOperatorAssignmentGeneration,
                now,
              });
              const revision = {
                activationId: input.activationId,
                generation: 1,
                communityId: input.communityId,
                network: configured,
                canonicalRoot: resolved.canonicalRoot,
                namespaceAuthorityReference: input.namespaceAuthorityReference,
                namespaceAuthorityGeneration: input.expectedNamespaceAuthorityGeneration,
                operatorAssignmentId: input.operatorAssignmentId,
                operatorAssignmentGeneration: input.expectedOperatorAssignmentGeneration,
              };
              const resultHash = yield* activationHash(revision);
              yield* insertRevision(transaction, {
                ...revision,
                hash: resultHash,
                displayRoot: resolved.displayRoot,
                status: "active",
                reasonCode: null,
                actorAccountId: input.accountId,
                authorityGrantId: yield* decoded(() => text(grant, "grant_id")),
                createdAt: now,
                activatedAt: now,
                suspendedAt: null,
                revokedAt: null,
                recordedAt: now,
              });
              yield* transaction.execute({
                label: "spaces-sale-namespace.current.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_current (
                         sale_namespace_activation_id,family,canonical_root,community_id,
                         current_generation,updated_at
                       ) VALUES ($1,'spaces',$2,$3,1,$4::timestamptz)`,
                values: [input.activationId, resolved.canonicalRoot, input.communityId, now],
                readonly: false,
              });
              yield* insertAction(transaction, {
                actionId: input.actionId,
                accountId: input.accountId,
                communityId: input.communityId,
                endpoint: CREATE_ENDPOINT,
                idempotencyKey: input.idempotencyKey,
                requestHash: hash,
                activationId: input.activationId,
                expectedGeneration: 0,
                resultHash,
                committedAt: now,
              });
              return {
                activation: yield* readActivation(transaction, input.activationId, 1),
                replayed: false,
              };
            }),
          ),
        );
      }),

    reviseSaleNamespace: (input: ReviseInput) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const hash = commandHash(
                "pirate-handle-spaces-sale-namespace-revise-request-v1",
                input,
                {
                  activation_id: input.activationId,
                  expected_activation_hash: input.expectedActivationHash,
                  requested_status: input.requestedStatus,
                },
              );
              const prior = yield* replay(transaction, input, REVISE_ENDPOINT);
              if (prior.rows[0] !== undefined) {
                return yield* replayed(transaction, prior.rows[0], {
                  hash,
                  communityId: input.communityId,
                });
              }
              const current = yield* readCurrentActivation(transaction, input, true);
              const currentRow = current.rows[0];
              if (currentRow === undefined) return yield* reject("sale_namespace_inactive", true);
              const previous = yield* decoded(() => spacesActivationFromRow(currentRow));
              if (
                previous.sale_namespace_activation_hash !== input.expectedActivationHash ||
                previous.status === "revoked" ||
                (previous.status === input.requestedStatus && input.requestedStatus !== "active")
              ) {
                return yield* reject("sale_namespace_inactive", true);
              }
              const authority = yield* salesAuthority(transaction, input);
              const grant = authority.rows[0];
              if (grant === undefined) return yield* reject("offering_unavailable");
              const origin = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.origin.read",
                text: `SELECT actor_account_id
                         FROM community_handle_sale_namespace_activation_revisions
                        WHERE sale_namespace_activation_id=$1
                          AND sale_namespace_activation_generation=1`,
                values: [input.activationId],
                readonly: false,
              });
              if (origin.rows[0]?.actor_account_id !== input.accountId) {
                return yield* reject("offering_unavailable");
              }
              const now = yield* databaseNow(transaction);
              const unchangedAuthority =
                input.namespaceAuthorityReference ===
                  previous.namespace_authority.namespace_authority_reference &&
                input.expectedNamespaceAuthorityGeneration ===
                  previous.namespace_authority.namespace_authority_generation;
              const unchangedAssignment =
                input.operatorAssignmentId === previous.operator.operator_assignment_id &&
                input.expectedOperatorAssignmentGeneration ===
                  previous.operator.operator_assignment_generation;
              if (input.requestedStatus === "active") {
                if (input.operatorFundingTermsConfirmed !== true) {
                  return yield* reject("offering_unavailable");
                }
                // A refresh must advance authority or assignment; a restoration
                // needs fresh authority and assignment generations (§5.3.13.4).
                if (
                  (previous.status === "active" && unchangedAuthority && unchangedAssignment) ||
                  (previous.status === "suspended" && (unchangedAuthority || unchangedAssignment))
                ) {
                  return yield* reject("sale_namespace_inactive", true);
                }
                const configured = yield* configuredNetwork(transaction);
                if (configured !== previous.network) {
                  return yield* reject("sale_namespace_inactive", true);
                }
                const resolved = yield* resolveAuthority(transaction, {
                  ...input,
                  network: configured,
                });
                if (resolved.canonicalRoot !== previous.canonical_root) {
                  return yield* reject("sale_namespace_inactive");
                }
                yield* requireReady(transaction, {
                  network: configured,
                  canonicalRoot: previous.canonical_root,
                  communityId: input.communityId,
                  namespaceAuthorityReference: input.namespaceAuthorityReference,
                  namespaceAuthorityGeneration: input.expectedNamespaceAuthorityGeneration,
                  operatorAssignmentId: input.operatorAssignmentId,
                  operatorAssignmentGeneration: input.expectedOperatorAssignmentGeneration,
                  now,
                });
              } else if (!unchangedAuthority || !unchangedAssignment) {
                // Suspension and revocation keep the references they stop.
                return yield* reject("sale_namespace_inactive", true);
              }
              const revision = {
                activationId: input.activationId,
                generation: previous.sale_namespace_activation_generation + 1,
                communityId: input.communityId,
                network: previous.network,
                canonicalRoot: previous.canonical_root,
                namespaceAuthorityReference: input.namespaceAuthorityReference,
                namespaceAuthorityGeneration: input.expectedNamespaceAuthorityGeneration,
                operatorAssignmentId: input.operatorAssignmentId,
                operatorAssignmentGeneration: input.expectedOperatorAssignmentGeneration,
              };
              const resultHash = yield* activationHash(revision);
              yield* insertRevision(transaction, {
                ...revision,
                hash: resultHash,
                displayRoot: previous.display_root,
                status: input.requestedStatus,
                reasonCode: input.requestedStatus === "active" ? null : "seller_transition",
                actorAccountId: input.accountId,
                authorityGrantId: yield* decoded(() => text(grant, "grant_id")),
                createdAt: previous.created_at,
                activatedAt: previous.activated_at ?? now,
                suspendedAt: input.requestedStatus === "suspended" ? now : null,
                revokedAt: input.requestedStatus === "revoked" ? now : null,
                recordedAt: now,
              });
              yield* transaction.execute({
                label: "spaces-sale-namespace.current.update",
                text: `UPDATE community_handle_sale_namespace_activation_current
                          SET current_generation=$2,updated_at=$3::timestamptz
                        WHERE sale_namespace_activation_id=$1`,
                values: [input.activationId, revision.generation, now],
                readonly: false,
              });
              yield* insertAction(transaction, {
                actionId: input.actionId,
                accountId: input.accountId,
                communityId: input.communityId,
                endpoint: REVISE_ENDPOINT,
                idempotencyKey: input.idempotencyKey,
                requestHash: hash,
                activationId: input.activationId,
                expectedGeneration: previous.sale_namespace_activation_generation,
                resultHash,
                committedAt: now,
              });
              return {
                activation: yield* readActivation(
                  transaction,
                  input.activationId,
                  revision.generation,
                ),
                replayed: false,
              };
            }),
          ),
        );
      }),

    getSaleNamespaceReadiness: (
      input: Parameters<SpacesSaleNamespaceStore["getSaleNamespaceReadiness"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const authority = yield* salesAuthority(transaction, input);
              if (authority.rows[0] === undefined) return null;
              const current = yield* readCurrentActivation(transaction, input, false);
              const currentRow = current.rows[0];
              if (currentRow === undefined) return null;
              const activation = yield* decoded(() => spacesActivationFromRow(currentRow));
              const { facts, readiness } = yield* readFacts(transaction, {
                network: activation.network,
                canonicalRoot: activation.canonical_root,
                communityId: activation.community_id,
                namespaceAuthorityReference:
                  activation.namespace_authority.namespace_authority_reference,
                namespaceAuthorityGeneration:
                  activation.namespace_authority.namespace_authority_generation,
                operatorAssignmentId: activation.operator.operator_assignment_id,
                operatorAssignmentGeneration: activation.operator.operator_assignment_generation,
                now: yield* databaseNow(transaction),
              });
              return { activation, facts, readiness };
            }),
          ),
        );
      }),

    recordRootObservation: (input: RootObservationInput) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const configured = yield* configuredNetwork(transaction);
              if (configured === null) return yield* reject("service_unavailable", true);
              yield* advisoryLock(
                transaction,
                53_001,
                ["spaces", input.canonicalRoot],
                "spaces-sale-namespace.root.lock",
              );
              const now = yield* databaseNow(transaction);
              const nowMs = Date.parse(now);
              const observedMs = Date.parse(input.observedAt);
              const latest = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.root-observation.latest.read",
                text: `SELECT observation_generation,observed_at
                         FROM spaces_root_observations
                        WHERE network=$1 AND canonical_root=$2
                        ORDER BY observation_generation DESC
                        LIMIT 1`,
                values: [configured, input.canonicalRoot],
                readonly: false,
              });
              const latestRow = latest.rows[0];
              if (
                !Number.isFinite(observedMs) ||
                observedMs > nowMs ||
                (latestRow !== undefined &&
                  observedMs < Date.parse(yield* decoded(() => instant(latestRow.observed_at))))
              ) {
                return { kind: "stale" as const };
              }
              const generation =
                latestRow === undefined
                  ? 1
                  : (yield* decoded(() => integer(latestRow, "observation_generation"))) + 1;
              const root = input.root;
              const anchorState =
                root.kind === "unresolved"
                  ? null
                  : nowMs - Date.parse(root.anchoredAt) > input.freshness.anchor_max_age_ms
                    ? "stale"
                    : root.anchorCoversRootOutpoint
                      ? "covers_root_outpoint"
                      : "pending";
              const history = input.commitmentHistory;
              yield* transaction.execute({
                label: "spaces-sale-namespace.root-observation.insert",
                text: `INSERT INTO spaces_root_observations (
                         network,canonical_root,observation_generation,observer_reference,
                         observed_at,fresh_until,root_state,root_outpoint,root_key_hex,anchored_at,
                         anchor_state,publication_state,delegation_address,commitment_history_state,
                         commitment_count,latest_commitment_root_hex,recorded_at
                       ) VALUES (
                         $1,$2,$3,$4,$5::timestamptz,
                         $5::timestamptz + ($6::bigint * interval '1 millisecond'),
                         $7,$8,$9,$10::timestamptz,$11,$12,$13,$14,$15,$16,$17::timestamptz
                       )`,
                values: [
                  configured,
                  input.canonicalRoot,
                  generation,
                  input.observerReference,
                  input.observedAt,
                  input.freshness.observation_max_age_ms,
                  root.kind,
                  root.kind === "resolved" ? root.outpoint : null,
                  root.kind === "resolved" ? root.key : null,
                  root.kind === "resolved" ? root.anchoredAt : null,
                  anchorState,
                  root.kind === "resolved" ? root.publication : null,
                  root.kind === "resolved" ? root.delegationAddress : null,
                  history.kind,
                  history.kind === "verified" ? history.commitmentCount : null,
                  history.kind === "verified" ? history.latestCommitmentRootHex : null,
                  now,
                ],
                readonly: false,
              });
              const active = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.root-observation.activation.lock",
                text: `SELECT revision.*,
                              evidence.root_key_hex AS evidence_root_key_hex,
                              assignment.delegation_address AS assignment_delegation_address
                         FROM community_handle_sale_namespace_activation_current AS current_activation
                         JOIN community_handle_sale_namespace_activation_revisions AS revision
                           ON revision.sale_namespace_activation_id=current_activation.sale_namespace_activation_id
                          AND revision.sale_namespace_activation_generation=current_activation.current_generation
                         JOIN spaces_namespace_authority_evidence AS evidence
                           ON evidence.namespace_authority_reference=revision.spaces_namespace_authority_reference
                          AND evidence.namespace_authority_generation=revision.spaces_namespace_authority_generation
                         JOIN spaces_operator_assignment_revisions AS assignment
                           ON assignment.operator_assignment_id=revision.spaces_operator_assignment_id
                          AND assignment.operator_assignment_generation=revision.spaces_operator_assignment_generation
                        WHERE current_activation.family='spaces'
                          AND current_activation.canonical_root=$1
                          AND revision.spaces_network=$2
                          AND revision.status='active'
                        FOR UPDATE OF current_activation`,
                values: [input.canonicalRoot, configured],
                readonly: false,
              });
              const activeRow = active.rows[0];
              if (activeRow === undefined) {
                return {
                  kind: "recorded" as const,
                  observation_generation: generation,
                  drift: null,
                  suspended: null,
                };
              }
              const activation = yield* decoded(() => spacesActivationFromRow(activeRow));
              const evidenceKey = yield* decoded(() => text(activeRow, "evidence_root_key_hex"));
              const assignedDelegation = activeRow.assignment_delegation_address;
              const drift: SpacesAuthorityDriftV1 = classifySpacesAuthorityObservationV1({
                evidence_root_key: evidenceKey,
                observation: {
                  observed_at_epoch_ms: observedMs,
                  root:
                    root.kind === "resolved"
                      ? { kind: "resolved", outpoint: root.outpoint, key: root.key }
                      : { kind: "unresolved" },
                  anchor:
                    root.kind === "resolved"
                      ? {
                          anchored_at_epoch_ms: Date.parse(root.anchoredAt),
                          covers_root_outpoint: root.anchorCoversRootOutpoint,
                        }
                      : { anchored_at_epoch_ms: observedMs, covers_root_outpoint: false },
                  delegation:
                    root.kind === "resolved" && root.delegationAddress === assignedDelegation
                      ? "observed"
                      : "absent",
                  publication: root.kind === "resolved" ? root.publication : "failed",
                },
                now_epoch_ms: nowMs,
                freshness: input.freshness,
              });
              if (drift.kind !== "authority_lost") {
                return {
                  kind: "recorded" as const,
                  observation_generation: generation,
                  drift,
                  suspended: null,
                };
              }
              // A fresh observation confirmed the loss: suspend with a new
              // generation. Restoration needs fresh authority and assignment.
              const revision = {
                activationId: activation.sale_namespace_activation_id,
                generation: activation.sale_namespace_activation_generation + 1,
                communityId: activation.community_id,
                network: activation.network,
                canonicalRoot: activation.canonical_root,
                namespaceAuthorityReference:
                  activation.namespace_authority.namespace_authority_reference,
                namespaceAuthorityGeneration:
                  activation.namespace_authority.namespace_authority_generation,
                operatorAssignmentId: activation.operator.operator_assignment_id,
                operatorAssignmentGeneration: activation.operator.operator_assignment_generation,
              };
              const resultHash = yield* activationHash(revision);
              yield* insertRevision(transaction, {
                ...revision,
                hash: resultHash,
                displayRoot: activation.display_root,
                status: "suspended",
                reasonCode: drift.reason,
                actorAccountId: yield* decoded(() => text(activeRow, "actor_account_id")),
                authorityGrantId: yield* decoded(() => text(activeRow, "authority_grant_id")),
                createdAt: activation.created_at,
                activatedAt: activation.activated_at ?? now,
                suspendedAt: now,
                revokedAt: null,
                recordedAt: now,
              });
              yield* transaction.execute({
                label: "spaces-sale-namespace.current.suspend",
                text: `UPDATE community_handle_sale_namespace_activation_current
                          SET current_generation=$2,updated_at=$3::timestamptz
                        WHERE sale_namespace_activation_id=$1`,
                values: [revision.activationId, revision.generation, now],
                readonly: false,
              });
              return {
                kind: "recorded" as const,
                observation_generation: generation,
                drift,
                suspended: yield* readActivation(
                  transaction,
                  revision.activationId,
                  revision.generation,
                ),
              };
            }),
          ),
        );
      }),

    recordOperatorCapabilityObservation: (
      input: Parameters<SpacesSaleNamespaceStore["recordOperatorCapabilityObservation"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const latest = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.capability.latest.read",
                text: `SELECT revision.operator_assignment_id,
                              observation.observation_generation,observation.observed_at
                         FROM spaces_operator_assignment_revisions AS revision
                         LEFT JOIN LATERAL (
                           SELECT candidate.observation_generation,candidate.observed_at
                             FROM spaces_operator_capability_observations AS candidate
                            WHERE candidate.operator_assignment_id=revision.operator_assignment_id
                              AND candidate.operator_assignment_generation
                                  =revision.operator_assignment_generation
                            ORDER BY candidate.observation_generation DESC
                            LIMIT 1
                         ) AS observation ON TRUE
                        WHERE revision.operator_assignment_id=$1
                          AND revision.operator_assignment_generation=$2
                        FOR UPDATE OF revision`,
                values: [input.operatorAssignmentId, input.operatorAssignmentGeneration],
                readonly: false,
              });
              const latestRow = latest.rows[0];
              if (latestRow === undefined) return yield* reject("sale_namespace_inactive", true);
              const previous =
                latestRow.observation_generation === null
                  ? null
                  : yield* decoded(() => ({
                      generation: integer(latestRow, "observation_generation"),
                      observedAt: instant(latestRow.observed_at),
                    }));
              if (
                !Number.isFinite(Date.parse(input.observedAt)) ||
                (previous !== null &&
                  Date.parse(input.observedAt) < Date.parse(previous.observedAt))
              ) {
                return { kind: "stale" as const };
              }
              const generation = (previous?.generation ?? 0) + 1;
              yield* transaction.execute({
                label: "spaces-sale-namespace.capability.insert",
                text: `INSERT INTO spaces_operator_capability_observations (
                         operator_assignment_id,operator_assignment_generation,observation_generation,
                         observed_at,fresh_until,capability_state
                       ) VALUES (
                         $1,$2,$3,$4::timestamptz,
                         $4::timestamptz + ($5::bigint * interval '1 millisecond'),$6
                       )`,
                values: [
                  input.operatorAssignmentId,
                  input.operatorAssignmentGeneration,
                  generation,
                  input.observedAt,
                  input.observationMaxAgeMs,
                  input.capability,
                ],
                readonly: false,
              });
              return { kind: "recorded" as const, observation_generation: generation };
            }),
          ),
        );
      }),

    recordFundingObservation: (
      input: Parameters<SpacesSaleNamespaceStore["recordFundingObservation"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const amounts = yield* Effect.try({
                try: () => {
                  const pattern = /^(?:0|[1-9][0-9]{0,19})$/u;
                  if (
                    !pattern.test(input.confirmedBalanceSats) ||
                    !pattern.test(input.nextCommitFeeSats)
                  ) {
                    throw new Error("invalid satoshi amount");
                  }
                  return {
                    balance: BigInt(input.confirmedBalanceSats),
                    fee: BigInt(input.nextCommitFeeSats),
                  };
                },
                catch: () => reject("service_unavailable"),
              });
              const latest = yield* transaction.execute<Row>({
                label: "spaces-sale-namespace.funding.latest.read",
                text: `SELECT revision.operator_assignment_id,
                              observation.observation_generation,observation.observed_at
                         FROM spaces_operator_assignment_revisions AS revision
                         LEFT JOIN LATERAL (
                           SELECT candidate.observation_generation,candidate.observed_at
                             FROM spaces_operator_funding_observations AS candidate
                            WHERE candidate.operator_assignment_id=revision.operator_assignment_id
                              AND candidate.operator_assignment_generation
                                  =revision.operator_assignment_generation
                            ORDER BY candidate.observation_generation DESC
                            LIMIT 1
                         ) AS observation ON TRUE
                        WHERE revision.operator_assignment_id=$1
                          AND revision.operator_assignment_generation=$2
                        FOR UPDATE OF revision`,
                values: [input.operatorAssignmentId, input.operatorAssignmentGeneration],
                readonly: false,
              });
              const latestRow = latest.rows[0];
              if (latestRow === undefined) return yield* reject("sale_namespace_inactive", true);
              const previous =
                latestRow.observation_generation === null
                  ? null
                  : yield* decoded(() => ({
                      generation: integer(latestRow, "observation_generation"),
                      observedAt: instant(latestRow.observed_at),
                    }));
              if (
                !Number.isFinite(Date.parse(input.observedAt)) ||
                (previous !== null &&
                  Date.parse(input.observedAt) < Date.parse(previous.observedAt))
              ) {
                return { kind: "stale" as const };
              }
              const status =
                amounts.balance >= amounts.fee
                  ? ("funded_v1" as const)
                  : ("commits_paused_insufficient_funds_v1" as const);
              yield* transaction.execute({
                label: "spaces-sale-namespace.funding.insert",
                text: `INSERT INTO spaces_operator_funding_observations (
                         operator_assignment_id,operator_assignment_generation,observation_generation,
                         observed_at,confirmed_balance_sats,next_commit_fee_sats,funding_status
                       ) VALUES ($1,$2,$3,$4::timestamptz,$5::numeric,$6::numeric,$7)`,
                values: [
                  input.operatorAssignmentId,
                  input.operatorAssignmentGeneration,
                  (previous?.generation ?? 0) + 1,
                  input.observedAt,
                  input.confirmedBalanceSats,
                  input.nextCommitFeeSats,
                  status,
                ],
                readonly: false,
              });
              return {
                kind: "recorded" as const,
                funding: {
                  status,
                  confirmed_balance_sats: input.confirmedBalanceSats,
                  top_up_address: null,
                  observed_at: yield* decoded(() => instant(input.observedAt)),
                },
              };
            }),
          ),
        );
      }),
  };
}

export function makeControlPlaneSpacesSaleNamespaceStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): SpacesSaleNamespaceStore {
  const repository = makeControlPlaneSpacesSaleNamespaceRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    mapped(Effect.provide(runtime)(effect));
  const store = {
    readCandidateReadiness: (
      input: Parameters<SpacesSaleNamespaceStore["readCandidateReadiness"]>[0],
    ) => provide(repository.readCandidateReadiness(input)),
    createSaleNamespace: (input: CreateInput) => provide(repository.createSaleNamespace(input)),
    reviseSaleNamespace: (input: ReviseInput) => provide(repository.reviseSaleNamespace(input)),
    getSaleNamespaceReadiness: (
      input: Parameters<SpacesSaleNamespaceStore["getSaleNamespaceReadiness"]>[0],
    ) => provide(repository.getSaleNamespaceReadiness(input)),
    recordRootObservation: (input: RootObservationInput) =>
      provide(repository.recordRootObservation(input)),
    recordOperatorCapabilityObservation: (
      input: Parameters<SpacesSaleNamespaceStore["recordOperatorCapabilityObservation"]>[0],
    ) => provide(repository.recordOperatorCapabilityObservation(input)),
    recordFundingObservation: (
      input: Parameters<SpacesSaleNamespaceStore["recordFundingObservation"]>[0],
    ) => provide(repository.recordFundingObservation(input)),
  };
  // The repository maps every ControlPlaneError before this boundary. The
  // assertion hides only Effect's conservative union left by withTransaction.
  return store as unknown as SpacesSaleNamespaceStore;
}
