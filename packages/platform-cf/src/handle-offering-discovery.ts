import {
  type ControlPlaneDb,
  HandleSalesPageRejected,
  type HandleSalesStore,
} from "@pirate/application";
import type {
  CommunityHandleOfferingDiscoveryV1,
  CommunityHandleOfferingV4,
} from "@pirate/contracts";
import { Effect } from "effect";
import {
  boolean,
  instant,
  integer,
  mapped,
  nullableInteger,
  nullableText,
  one,
  type Row,
  storage,
  text,
} from "./handle-sales-internals.ts";
import { decodePageCursor, encodePageCursor, pageLimit } from "./handle-sales-page-cursor.ts";
import {
  assessSpacesDiscoveryAuthority,
  observeSpacesDiscoveryRoots,
  type SpacesDiscoveryAuthority,
  type SpacesDiscoveryBinding,
  spacesDiscoveryRootKey,
} from "./spaces-discovery-authority.ts";

// Required authorization records use LEFT JOIN so their absence fails decoding,
// rather than silently removing an offering as if loss had been established.
const SELECT_DISCOVERY = `
  SELECT revision.*,
         policy.policy_kind,policy.policy_id,policy.policy_revision,policy.policy_hash,
         policy.provider_binding_hash,policy.nationality_policy,policy.subject_account_id,
         current_offering.offering_id AS discovery_current_offering_id,
         current_offering.current_revision AS discovery_current_offering_revision,
         activation.sale_namespace_activation_id AS discovery_activation_id,
         current_activation.sale_namespace_activation_id AS discovery_current_activation_id,
         community.community_id AS discovery_community_id,
         EXISTS (
           SELECT 1 FROM effective_community_handle_sale_namespace_v1(
             revision.sale_namespace_activation_id,clock_timestamp()
           ) AS effective
           WHERE effective.sale_namespace_activation_generation=
                   revision.sale_namespace_activation_generation
             AND effective.family=revision.family
             AND effective.community_id=revision.community_id
             AND effective.canonical_root=revision.namespace_root
         ) AS discovery_ready,
         (revision.status='active'
           AND (current_offering.offering_id IS NULL
            OR current_offering.current_revision=revision.offering_revision)
           AND activation.family=revision.family
           AND activation.community_id=revision.community_id
           AND activation.canonical_root=revision.namespace_root
           AND activation.status='active'
           AND current_activation.current_generation=revision.sale_namespace_activation_generation
           AND current_activation.family=activation.family
           AND current_activation.community_id=activation.community_id
           AND current_activation.canonical_root=activation.canonical_root
           AND community.status='active'
           AND authority.community_id=activation.community_id
           AND authority.network=activation.spaces_network
           AND authority.canonical_root=activation.canonical_root
           AND latest_authority.community_id=authority.community_id
           AND latest_authority.network=authority.network
           AND latest_authority.canonical_root=authority.canonical_root
           AND latest_authority.root_key_hex=authority.root_key_hex
           AND latest_authority.root_outpoint=authority.root_outpoint
           AND assignment.current_generation=activation.spaces_operator_assignment_generation
           AND assignment.network=activation.spaces_network
           AND assignment.canonical_root=activation.canonical_root
           AND assignment.status='active'
         ) AS discovery_spaces_authorized,
         activation.spaces_network AS discovery_network,
         activation.spaces_namespace_authority_generation AS discovery_authority_generation,
         authority.namespace_authority_reference AS discovery_authority_reference,
         authority.root_key_hex AS discovery_root_key,
         authority.root_outpoint AS discovery_outpoint,
         latest_authority.namespace_authority_reference AS discovery_latest_authority_reference,
         latest_authority.namespace_authority_generation AS discovery_latest_authority_generation,
         (latest_authority.community_id=authority.community_id
           AND latest_authority.network=authority.network
           AND latest_authority.canonical_root=authority.canonical_root
           AND latest_authority.root_key_hex=authority.root_key_hex
           AND latest_authority.root_outpoint=authority.root_outpoint
         ) AS discovery_latest_binding_same,
         assignment.operator_assignment_id AS discovery_assignment_id,
         assignment.current_generation AS discovery_assignment_generation,
         assignment.delegation_address AS discovery_delegation_address,
         observation.observation_generation AS discovery_observation_generation,
         observation.commitment_count AS discovery_commitment_count,
         observation.latest_commitment_root_hex AS discovery_latest_commitment
    FROM community_handle_offering_revisions AS revision
    LEFT JOIN handle_qualification_policy_revisions AS policy
      ON policy.policy_id=revision.qualification_policy_id
     AND policy.policy_revision=revision.qualification_policy_revision
    LEFT JOIN community_handle_offering_current AS current_offering
      ON current_offering.offering_id=revision.offering_id
    LEFT JOIN community_handle_sale_namespace_activation_revisions AS activation
      ON activation.sale_namespace_activation_id=revision.sale_namespace_activation_id
     AND activation.sale_namespace_activation_generation=revision.sale_namespace_activation_generation
    LEFT JOIN community_handle_sale_namespace_activation_current AS current_activation
      ON current_activation.sale_namespace_activation_id=revision.sale_namespace_activation_id
    LEFT JOIN communities AS community ON community.community_id=revision.community_id
    LEFT JOIN spaces_namespace_authority_evidence AS authority
      ON authority.namespace_authority_reference=activation.spaces_namespace_authority_reference
     AND authority.namespace_authority_generation=activation.spaces_namespace_authority_generation
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM spaces_namespace_authority_evidence AS candidate
       WHERE candidate.namespace_authority_reference=authority.namespace_authority_reference
       ORDER BY candidate.namespace_authority_generation DESC LIMIT 1
    ) AS latest_authority ON TRUE
    LEFT JOIN spaces_operator_assignment_current AS assignment
      ON assignment.operator_assignment_id=activation.spaces_operator_assignment_id
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM spaces_root_observations AS candidate
       WHERE candidate.network=activation.spaces_network
         AND candidate.canonical_root=activation.canonical_root
       ORDER BY candidate.observation_generation DESC LIMIT 1
    ) AS observation ON TRUE`;

type Facts = Readonly<{
  authorized: boolean;
  ready: boolean;
  binding: SpacesDiscoveryBinding;
  fingerprint: string;
}>;

const rowKey = (row: Row): string =>
  JSON.stringify([text(row, "offering_id"), integer(row, "offering_revision")]);

const requireAuthorizationRecords = (row: Row): void => {
  for (const key of [
    "discovery_current_offering_id",
    "discovery_activation_id",
    "discovery_current_activation_id",
    "discovery_community_id",
  ])
    text(row, key);
};

const spacesFacts = (row: Row): Facts => {
  requireAuthorizationRecords(row);
  const authorityReference = text(row, "discovery_authority_reference");
  const latestAuthorityReference = text(row, "discovery_latest_authority_reference");
  const assignmentId = text(row, "discovery_assignment_id");
  const binding: SpacesDiscoveryBinding = {
    network: text(row, "discovery_network"),
    canonicalRoot: text(row, "namespace_root"),
    rootKey: text(row, "discovery_root_key"),
    outpoint: text(row, "discovery_outpoint"),
    delegationAddress: text(row, "discovery_delegation_address"),
    commitmentCount: nullableInteger(row, "discovery_commitment_count"),
    latestRoot: nullableText(row, "discovery_latest_commitment"),
  };
  const authorized = boolean(row, "discovery_spaces_authorized");
  const ready = boolean(row, "discovery_ready") && boolean(row, "discovery_latest_binding_same");
  return {
    authorized,
    ready,
    binding,
    fingerprint: JSON.stringify([
      authorized,
      ready,
      binding,
      authorityReference,
      integer(row, "discovery_authority_generation"),
      latestAuthorityReference,
      integer(row, "discovery_latest_authority_generation"),
      assignmentId,
      integer(row, "discovery_assignment_generation"),
      nullableInteger(row, "discovery_observation_generation"),
    ]),
  };
};

const decode = <A>(read: () => A) => Effect.try({ try: read, catch: () => storage("invalid-row") });

/** Public visibility never supplies transaction admission. */
export const listHandleOfferingDiscovery = Effect.fn("listHandleOfferingDiscovery")(function* (
  db: ControlPlaneDb["Service"],
  authority: SpacesDiscoveryAuthority,
  input: Parameters<HandleSalesStore["listOfferings"]>[0],
  offeringFromRow: (row: Row) => CommunityHandleOfferingV4,
) {
  const paging = yield* Effect.try({
    try: () => ({
      limit: pageLimit(input.limit),
      cursor: decodePageCursor(input.cursor, "offerings", input.communityId),
    }),
    catch: (error) =>
      error instanceof HandleSalesPageRejected
        ? error
        : new HandleSalesPageRejected({ reason: "invalid_cursor" }),
  });
  const clock =
    paging.cursor === null
      ? yield* mapped(
          db.execute<Row>({
            label: "handle-sales.offering.list-clock",
            text: "SELECT clock_timestamp() AS database_now",
            values: [],
            readonly: true,
          }),
        )
      : null;
  const cutoff =
    paging.cursor?.snapshotCutoff ??
    (yield* decode(() => instant(one(clock?.rows ?? [], "discovery clock").database_now)));
  const result = yield* mapped(
    db.execute<Row>({
      label: "handle-sales.offering.list-public",
      text: `${SELECT_DISCOVERY}
        WHERE revision.community_id=$1 AND revision.status='active'
          AND (current_offering.offering_id IS NULL
            OR current_offering.current_revision=revision.offering_revision)
          AND (revision.family='spaces'
            OR current_offering.offering_id IS NULL
            OR activation.sale_namespace_activation_id IS NULL
            OR current_activation.sale_namespace_activation_id IS NULL
            OR community.community_id IS NULL
            OR EXISTS (
            SELECT 1 FROM effective_community_handle_sale_namespace_v1(
              revision.sale_namespace_activation_id,clock_timestamp()
            ) AS effective
            WHERE effective.sale_namespace_activation_generation=
                    revision.sale_namespace_activation_generation
              AND effective.family='hns'
          ))
          AND revision.created_at <= $2::timestamptz
          AND ($3::timestamptz IS NULL
            OR (revision.created_at,revision.offering_id)<($3::timestamptz,$4))
        ORDER BY revision.created_at DESC,revision.offering_id DESC LIMIT $5`,
      values: [
        input.communityId,
        cutoff,
        paging.cursor?.sortTime ?? null,
        paging.cursor?.sortId ?? null,
        paging.limit + 1,
      ],
      readonly: true,
    }),
  );
  const selected = result.rows.slice(0, paging.limit);
  const before = yield* decode(
    () =>
      new Map(
        selected.map((row) => {
          requireAuthorizationRecords(row);
          return [rowKey(row), row.family === "spaces" ? spacesFacts(row) : null];
        }),
      ),
  );
  const observations = yield* observeSpacesDiscoveryRoots(
    authority,
    Array.from(before.values()).flatMap((facts) => (facts?.authorized ? [facts.binding] : [])),
  );
  // Every candidate, including an unobserved or timed-out root, gets a current
  // authorization read after the external wait. The cursor never authorizes it.
  const rechecked =
    selected.length === 0
      ? { rows: [] }
      : yield* mapped(
          db.execute<Row>({
            label: "handle-sales.offering.discovery-recheck",
            text: `${SELECT_DISCOVERY}
        WHERE (revision.offering_id,revision.offering_revision) IN (
          SELECT * FROM unnest($1::text[],$2::bigint[])
        )`,
            values: [
              selected.map((row) => text(row, "offering_id")),
              selected.map((row) => integer(row, "offering_revision")),
            ],
            readonly: true,
          }),
        );
  return yield* decode(() => {
    const after = new Map(rechecked.rows.map((row) => [rowKey(row), row]));
    if (after.size !== selected.length || rechecked.rows.length !== selected.length)
      throw new Error("missing discovery authorization");
    const items: CommunityHandleOfferingDiscoveryV1[] = [];
    for (const row of selected) {
      const current = after.get(rowKey(row));
      if (current === undefined) throw new Error("missing discovery candidate");
      requireAuthorizationRecords(current);
      const item = offeringFromRow(row);
      if (item.family !== "spaces") {
        if (
          boolean(current, "discovery_ready") &&
          integer(current, "discovery_current_offering_revision") === item.offering_revision
        )
          items.push(item);
        continue;
      }
      const facts = spacesFacts(current);
      if (!facts.authorized) continue;
      const assessment = assessSpacesDiscoveryAuthority(
        facts.binding,
        observations.get(spacesDiscoveryRootKey(facts.binding)) ?? {
          kind: "temporarily_unavailable",
        },
      );
      if (assessment === "verified_ownership_loss") continue;
      const available =
        facts.ready &&
        assessment === "available" &&
        before.get(rowKey(row))?.fingerprint === facts.fingerprint;
      items.push({
        ...item,
        current_availability: { kind: available ? "available" : "temporarily_unavailable" },
      });
    }
    const last = selected[selected.length - 1];
    return {
      items,
      next_cursor:
        result.rows.length > paging.limit && last !== undefined
          ? encodePageCursor("offerings", input.communityId, {
              snapshotCutoff: cutoff,
              sortTime: instant(last.created_at),
              sortId: text(last, "offering_id"),
            })
          : null,
    };
  });
});
