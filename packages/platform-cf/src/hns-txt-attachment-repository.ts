import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneResult,
  type HnsCommunityRootImportStartStore,
  HnsCommunityRootImportStorageFailed,
  type HnsTxtAttachmentState,
  type HnsTxtAttachmentStore,
} from "@pirate/application";
import { Effect, type Layer } from "effect";
import {
  type HnsCommunityRootImportRepositoryOptions,
  makeControlPlaneHnsCommunityRootImportStartStore,
} from "./hns-community-root-import-repository.ts";

type Row = Readonly<Record<string, unknown>>;

/**
 * A TXT-only attachment is held for one day. An abandoned attempt keeps the
 * community and root reserved no longer than that, and its preparation still
 * counts against the actor's daily quota.
 */
export const HNS_TXT_ATTACHMENT_PREPARATION_TTL_SECONDS = 86_400;

const invariantFailure = (reason: string) => new HnsCommunityRootImportStorageFailed({ reason });

function oneRow<T>(result: ControlPlaneResult<T>): T | null | undefined {
  if (result.rows.length > 1) return undefined;
  return result.rows[0] ?? null;
}

function text(row: Row, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function instant(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

const intentStatuses = new Set([
  "verification_required",
  "commit_ready",
  "committed",
  "failed",
  "expired",
]);
const ownershipStatuses = new Set(["pending", "completed", "failed", "expired"]);

/**
 * A TXT-only attachment is a community import preparation that never gained a
 * root-import session. Every query below scopes to that shape.
 */
const TXT_ONLY_PREPARATION = `NOT EXISTS (
  SELECT 1 FROM hns_root_import_sessions AS import_session
   WHERE import_session.root_import_session_id = preparation.root_import_session_id)`;

function decodeState(row: Row): HnsTxtAttachmentState | null {
  const attachmentIntentId = text(row, "attachment_intent_id");
  const rootLabel = text(row, "root_label");
  const intentStatus = text(row, "intent_status");
  const intentExpiresAt = instant(row.intent_expires_at);
  const routeHref = row.route_href === null ? null : text(row, "route_href");
  if (
    attachmentIntentId === null ||
    rootLabel === null ||
    intentStatus === null ||
    !intentStatuses.has(intentStatus) ||
    intentExpiresAt === null ||
    (row.route_href !== null && routeHref === null)
  ) {
    return null;
  }
  let ownership: HnsTxtAttachmentState["ownership"] = null;
  if (row.namespace_session_id !== null) {
    const namespaceSessionId = text(row, "namespace_session_id");
    const ceremonyIntentId = text(row, "ceremony_intent_id");
    const expectedRevision = integer(row.expected_revision);
    const status = text(row, "ownership_status");
    const upstreamSessionRef = text(row, "upstream_session_ref");
    const expiresAt = instant(row.ownership_expires_at);
    if (
      namespaceSessionId === null ||
      ceremonyIntentId === null ||
      expectedRevision === null ||
      status === null ||
      !ownershipStatuses.has(status) ||
      upstreamSessionRef === null ||
      expiresAt === null
    ) {
      return null;
    }
    ownership = {
      namespace_session_id: namespaceSessionId,
      ceremony_intent_id: ceremonyIntentId,
      expected_revision: expectedRevision,
      status: status as NonNullable<HnsTxtAttachmentState["ownership"]>["status"],
      upstream_session_ref: upstreamSessionRef,
      expires_at: expiresAt,
    };
  }
  return {
    attachment_intent_id: attachmentIntentId,
    root_label: rootLabel,
    intent_status: intentStatus as HnsTxtAttachmentState["intent_status"],
    intent_expires_at: intentExpiresAt,
    ownership,
    route_href: routeHref,
  };
}

function load(input: Parameters<HnsTxtAttachmentStore["load"]>[0]) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    const authority = yield* db.execute<Row>({
      label: "hns.txt-attachment.authority",
      text: `SELECT has_community_route_authority(community_id,$1) AS allowed
               FROM communities WHERE community_id=$2 AND status='active'`,
      values: [input.actor_id, input.community_id],
      readonly: true,
    });
    const authorityRow = oneRow(authority);
    if (authorityRow === undefined) return yield* Effect.fail(invariantFailure("authority.rows"));
    if (authorityRow?.allowed !== true) return { kind: "unauthorized" } as const;
    const result = yield* db.execute<Row>({
      label: "hns.txt-attachment.load",
      text: `SELECT intent.attachment_intent_id, intent.root_label,
                    intent.status AS intent_status, intent.expires_at AS intent_expires_at,
                    ownership.namespace_session_id, ownership.ceremony_intent_id,
                    ownership.expected_revision, ownership.status AS ownership_status,
                    ownership.upstream_session_ref, ownership.expires_at AS ownership_expires_at,
                    CASE WHEN binding.route_lifecycle_status='active'
                               AND binding.ownership_status='verified'
                               AND evidence.expires_at>clock_timestamp()
                               AND target.canonical_route_binding_id=binding.route_binding_id
                         THEN binding.public_href_v2 END AS route_href
               FROM communities AS target
               JOIN community_route_attachment_intents AS intent
                 ON intent.community_id=target.community_id AND intent.family='hns'
               JOIN hns_community_root_import_preparations AS preparation
                 ON preparation.attachment_intent_id=intent.attachment_intent_id
               LEFT JOIN LATERAL (
                 SELECT session.* FROM community_route_attachment_namespace_sessions AS session
                  WHERE session.attachment_intent_id=intent.attachment_intent_id
                  ORDER BY session.generation DESC, session.created_at DESC LIMIT 1
               ) AS ownership ON TRUE
               LEFT JOIN community_canonical_route_bindings AS binding
                 ON binding.route_binding_id=intent.committed_route_binding_id
               LEFT JOIN community_route_ownership_evidence AS evidence
                 ON evidence.evidence_ref=binding.verified_evidence_ref
              WHERE target.community_id=$1
                AND ($2::text IS NULL OR intent.attachment_intent_id=$2)
                AND ${TXT_ONLY_PREPARATION}
              ORDER BY intent.created_at DESC LIMIT 1`,
      values: [input.community_id, input.attachment_intent_id],
      readonly: true,
    });
    const row = oneRow(result);
    if (row === undefined) return yield* Effect.fail(invariantFailure("load.rows"));
    if (row === null) return { kind: "authorized", state: null } as const;
    const state = decodeState(row);
    if (state === null) return yield* Effect.fail(invariantFailure("load.undecodable_row"));
    return { kind: "authorized", state } as const;
  });
}

function commit(input: Parameters<HnsTxtAttachmentStore["commit"]>[0]) {
  return Effect.gen(function* () {
    const db = yield* ControlPlaneDb;
    return yield* db.withTransaction((transaction) =>
      Effect.gen(function* () {
        const locked = yield* transaction.execute<Row>({
          label: "hns.txt-attachment.commit.lock-intent",
          text: `SELECT intent.revision, intent.status, intent.root_label,
                        state.generation, result.evidence_ref,
                        evidence.expires_at>clock_timestamp() AS evidence_live
                   FROM community_route_attachment_intents AS intent
                   JOIN hns_community_root_import_preparations AS preparation
                     ON preparation.attachment_intent_id=intent.attachment_intent_id
                   JOIN community_route_attachment_requirement_states AS state
                     ON state.attachment_intent_id=intent.attachment_intent_id
                    AND state.requirement_kind='namespace_ownership'
                   LEFT JOIN community_route_attachment_ceremony_results AS result
                     ON result.ceremony_intent_id=state.current_ceremony_intent_id
                   LEFT JOIN community_route_ownership_evidence AS evidence
                     ON evidence.evidence_ref=result.evidence_ref
                  WHERE intent.actor_id=$1 AND intent.community_id=$2
                    AND intent.attachment_intent_id=$3 AND intent.family='hns'
                    AND has_community_route_authority(intent.community_id,intent.actor_id)
                    AND ${TXT_ONLY_PREPARATION}
                  FOR UPDATE OF intent, state`,
          values: [input.actor_id, input.community_id, input.attachment_intent_id],
          readonly: false,
        });
        const row = oneRow(locked);
        if (row === undefined) return yield* Effect.fail(invariantFailure("lock-intent.rows"));
        if (row === null) return { kind: "not_found" } as const;
        if (row.status === "committed") return { kind: "replayed" } as const;
        const revision = integer(row.revision);
        const generation = integer(row.generation);
        const rootLabel = text(row, "root_label");
        const evidenceRef = text(row, "evidence_ref");
        if (
          row.status !== "commit_ready" ||
          revision === null ||
          generation === null ||
          rootLabel === null ||
          evidenceRef === null ||
          row.evidence_live !== true
        ) {
          return { kind: "conflict" } as const;
        }
        const taken = yield* transaction.execute<Row>({
          label: "hns.txt-attachment.commit.check-root",
          text: `SELECT EXISTS (
                   SELECT 1 FROM community_canonical_route_bindings
                    WHERE family='hns' AND root_label=$1 AND route_lifecycle_status='active'
                 ) AS taken`,
          values: [rootLabel],
          readonly: false,
        });
        if (oneRow(taken)?.taken !== false) return { kind: "ownership_conflict" } as const;
        const binding = yield* transaction.execute({
          label: "hns.txt-attachment.commit.insert-route-binding",
          text: `INSERT INTO community_canonical_route_bindings (
                   route_binding_id,community_id,family,root_label,root_label_display,
                   ownership_status,route_lifecycle_status,binding_generation,
                   verified_evidence_ref,route_authority_kind
                 ) VALUES ($1,$2,'hns',$3,$3,'verified','active',$4::bigint,$5,
                   'verified_namespace_v1')`,
          values: [input.route_binding_id, input.community_id, rootLabel, generation, evidenceRef],
          readonly: false,
        });
        if (binding.rowCount !== 1) return yield* Effect.fail(invariantFailure("insert-binding"));
        const community = yield* transaction.execute({
          label: "hns.txt-attachment.commit.bind-community-route",
          text: `UPDATE communities SET canonical_route_binding_id=$1,updated_at=clock_timestamp()
                  WHERE community_id=$2 AND canonical_route_binding_id IS NULL
                    AND status='active' AND route_authority_version='optional_route_v2'`,
          values: [input.route_binding_id, input.community_id],
          readonly: false,
        });
        if (community.rowCount !== 1) return { kind: "conflict" } as const;
        const committedResource = JSON.stringify({
          authority_version: "optional_route_v2",
          community_id: input.community_id,
          href: `/c/${input.community_id}`,
          canonical_route: {
            family: "hns",
            root_label: rootLabel,
            root_label_display: rootLabel,
            path_segment: `app.${rootLabel}`,
            href: `/c/app.${rootLabel}`,
            app_host: null,
          },
        });
        const intent = yield* transaction.execute({
          label: "hns.txt-attachment.commit.commit-intent",
          text: `UPDATE community_route_attachment_intents
                    SET status='committed',revision=revision+1,
                        committed_route_binding_id=$1,committed_resource=$2::jsonb,
                        updated_at=clock_timestamp()
                  WHERE actor_id=$3 AND community_id=$4 AND attachment_intent_id=$5
                    AND status='commit_ready' AND revision=$6::bigint`,
          values: [
            input.route_binding_id,
            committedResource,
            input.actor_id,
            input.community_id,
            input.attachment_intent_id,
            revision,
          ],
          readonly: false,
        });
        if (intent.rowCount !== 1) return yield* Effect.fail(invariantFailure("commit-intent"));
        return { kind: "committed" } as const;
      }),
    );
  });
}

export function makeControlPlaneHnsTxtAttachmentStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  options: Omit<HnsCommunityRootImportRepositoryOptions, "session_ttl_seconds">,
): Pick<HnsCommunityRootImportStartStore, "prepare"> & HnsTxtAttachmentStore {
  const preparations = makeControlPlaneHnsCommunityRootImportStartStore(runtime, {
    ...options,
    session_ttl_seconds: HNS_TXT_ATTACHMENT_PREPARATION_TTL_SECONDS,
  });
  const provide = <A>(effect: Effect.Effect<A, unknown, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect).pipe(
      Effect.mapError((error) =>
        error instanceof HnsCommunityRootImportStorageFailed
          ? error
          : new HnsCommunityRootImportStorageFailed({ cause: error }),
      ),
    );
  return {
    prepare: preparations.prepare,
    load: (input) => provide(load(input)),
    commit: (input) => provide(commit(input)),
  };
}
