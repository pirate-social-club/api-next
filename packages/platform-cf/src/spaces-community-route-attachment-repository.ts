import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ControlPlaneDb, ControlPlaneTransaction } from "@pirate/application";
import { SpacesRouteAttachmentRefused } from "@pirate/contracts";
import { isCanonicalSpacesRootV1 } from "@pirate/domain";
import { Effect } from "effect";
import {
  SPACES_ROUTE_CHALLENGE_SECONDS,
  SPACES_ROUTE_EVIDENCE_LEASE_SECONDS,
  SPACES_ROUTE_PROVIDER_ID,
  SPACES_ROUTE_RENEW_AFTER_SECONDS,
  SPACES_ROUTE_VERIFIER_CONTRACT,
  spacesRouteCanonicalHrefV1,
  spacesRouteEvidenceDigestV1,
  spacesRouteOwnerIdentityDigestV1,
  spacesRouteOwnerMessageV1,
  spacesRouteProviderConfigurationDigestV1,
  spacesRouteRequirementHashV1,
  spacesRouteStartRequestHashV1,
} from "./spaces-community-route-codec.ts";
import {
  spacesOwnerChallengeDigestV1,
  spacesOwnerSignatureValidV1,
} from "./spaces-owner-proof-codec.ts";
import type { SpacesRootRouteObserver } from "./spaces-root-authority-observer.ts";

/**
 * Attaches an already-owned Spaces root as the first canonical route of a
 * community. Ownership comes only from the verifier's ownership-only route, so
 * member-name issuance state can never suspend or delay an address. Every
 * expiry decision here reads the database clock; the Worker clock is never
 * compared with a stored deadline.
 */
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hexId = () => randomUUID().replaceAll("-", "");
const iso = (value: unknown): string => new Date(value as string).toISOString();
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Invalid Spaces route attachment row");
  return value;
};
const number = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("Invalid Spaces route attachment row");
  return parsed;
};

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;
type Environment = "development" | "staging" | "production";

const query = async (tx: Transaction, label: string, sql: string, values: readonly unknown[]) =>
  Effect.runPromise(tx.execute<Row>({ label, text: sql, values, readonly: false }));

const transact = <T>(
  db: ControlPlaneDb["Service"],
  action: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  Effect.runPromise(
    db.withTransaction((tx) => Effect.tryPromise({ try: () => action(tx), catch: (e) => e })),
  );

const OPEN = ["awaiting_signature", "proved"] as const;
const isOpen = (status: unknown): boolean => status === "awaiting_signature" || status === "proved";

/** `live` is computed by PostgreSQL in the same statement that read the row. */
const SELECT_ATTACHMENT = `SELECT attachment.*, attachment.expires_at > clock_timestamp() AS live
  FROM spaces_community_route_attachments AS attachment`;

export type SpacesRouteAttachmentStore = Readonly<{
  start: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      canonicalRoot: string;
      idempotencyKey: string;
    }>,
  ) => Promise<unknown>;
  current: (input: Readonly<{ accountId: string; communityId: string }>) => Promise<unknown>;
  prove: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      attachmentIntentId: string;
      signatureHex: string;
    }>,
  ) => Promise<unknown>;
  commit: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      attachmentIntentId: string;
      generation: number;
    }>,
  ) => Promise<unknown>;
}>;

const lockRoot = async (tx: Transaction, environment: string, root: string): Promise<void> => {
  await query(
    tx,
    "spaces-route.root.lock",
    "SELECT pg_advisory_xact_lock(hashtextextended($1,202613))",
    [`${environment}:mainnet:${root}`],
  );
};

/** Locks the community and requires live `manage_routes` authority for the actor. */
const lockAuthorizedCommunity = async (
  tx: Transaction,
  accountId: string,
  communityId: string,
): Promise<Row> => {
  const result = await query(
    tx,
    "spaces-route.community.lock",
    `SELECT community.canonical_route_binding_id,
            has_community_route_authority(community.community_id,$2) AS authorized,
            EXISTS (SELECT 1 FROM community_canonical_route_bindings AS binding
                     WHERE binding.community_id=community.community_id) AS ever_bound
       FROM communities AS community
      WHERE community.community_id=$1 AND community.status='active'
        AND community.route_authority_version='optional_route_v2'
      FOR UPDATE OF community`,
    [communityId, accountId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || row.authorized !== true)
    throw new SpacesRouteAttachmentRefused("forbidden");
  return row;
};

const checkMainnet = async (tx: Transaction): Promise<void> => {
  const result = await query(
    tx,
    "spaces-route.network",
    `SELECT network FROM spaces_network_configuration
      WHERE configuration_key='spaces_network_v1' FOR SHARE`,
    [],
  );
  if (result.rows.length !== 1 || result.rows[0]?.network !== "mainnet")
    throw new SpacesRouteAttachmentRefused("unavailable");
};

const pending = {
  contract: "pirate-spaces-community-route-attachment-v1",
  status: "verification_pending",
  retry_after_seconds: 30,
} as const;

/** An open challenge past its database deadline reads as expired at once. */
const stateResponse = (row: Row, replayed: boolean) => ({
  contract: "pirate-spaces-community-route-attachment-v1" as const,
  attachment_intent_id: text(row.attachment_intent_id),
  ceremony_intent_id: text(row.ceremony_intent_id),
  generation: number(row.generation),
  community_id: text(row.community_id),
  network: "mainnet" as const,
  canonical_root: text(row.canonical_root),
  status: isOpen(row.status) && row.live !== true ? ("expired" as const) : text(row.status),
  root_outpoint: text(row.root_outpoint),
  owner_public_key_hex: text(row.root_key_hex),
  public_origin: text(row.public_origin),
  canonical_href: text(row.canonical_href),
  challenge_message: text(row.challenge_message),
  challenge_digest_hex: text(row.challenge_digest_hex),
  expires_at: iso(row.expires_at),
  route_binding_id: typeof row.route_binding_id === "string" ? row.route_binding_id : null,
  replayed,
});

const finish = async (
  tx: Transaction,
  row: Row,
  status: "expired" | "root_changed" | "signature_rejected",
): Promise<unknown> => {
  const updated = await query(
    tx,
    "spaces-route.attachment.finish",
    `WITH changed AS (
       UPDATE spaces_community_route_attachments SET status=$2,updated_at=clock_timestamp()
        WHERE attachment_intent_id=$1 RETURNING *)
     SELECT changed.*, changed.expires_at > clock_timestamp() AS live FROM changed`,
    [row.attachment_intent_id, status],
  );
  return stateResponse(updated.rows[0] ?? row, false);
};

const loadOwned = async (
  tx: Transaction,
  input: Readonly<{ accountId: string; communityId: string; attachmentIntentId: string }>,
  environment: Environment,
): Promise<Row> => {
  const preliminary = await query(
    tx,
    "spaces-route.attachment.root",
    "SELECT canonical_root FROM spaces_community_route_attachments WHERE attachment_intent_id=$1",
    [input.attachmentIntentId],
  );
  if (preliminary.rows.length !== 1) throw new SpacesRouteAttachmentRefused("not_found");
  await lockRoot(tx, environment, text(preliminary.rows[0]?.canonical_root));
  await checkMainnet(tx);
  await lockAuthorizedCommunity(tx, input.accountId, input.communityId);
  const result = await query(
    tx,
    "spaces-route.attachment.read",
    `${SELECT_ATTACHMENT} WHERE attachment.attachment_intent_id=$1 FOR UPDATE OF attachment`,
    [input.attachmentIntentId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.environment !== environment ||
    row.account_id !== input.accountId ||
    row.community_id !== input.communityId
  ) {
    throw new SpacesRouteAttachmentRefused("not_found");
  }
  return row;
};

export function makeSpacesRouteAttachmentStore(
  options: Readonly<{
    db: ControlPlaneDb["Service"];
    observer: SpacesRootRouteObserver;
    environment: Environment;
    /** Trusted configuration; never taken from the request. */
    publicOrigin: string;
  }>,
): SpacesRouteAttachmentStore {
  const { db, observer, environment, publicOrigin } = options;
  if (!/^https:\/\/[a-z0-9.-]{1,253}$/u.test(publicOrigin))
    throw new TypeError("Spaces route public origin is invalid");
  const providerConfigurationDigest = spacesRouteProviderConfigurationDigestV1({
    environment,
    publicOrigin,
  });
  return {
    start: async (input) => {
      if (!isCanonicalSpacesRootV1(input.canonicalRoot))
        throw new SpacesRouteAttachmentRefused("invalid");
      return transact(db, async (tx) => {
        await lockRoot(tx, environment, input.canonicalRoot);
        await checkMainnet(tx);
        const community = await lockAuthorizedCommunity(tx, input.accountId, input.communityId);
        const requestHash = spacesRouteStartRequestHashV1({ environment, ...input });
        const replay = await query(
          tx,
          "spaces-route.start.replay",
          `${SELECT_ATTACHMENT}
            WHERE attachment.account_id=$1 AND attachment.community_id=$2
              AND attachment.start_idempotency_key=$3 FOR UPDATE OF attachment`,
          [input.accountId, input.communityId, input.idempotencyKey],
        );
        const prior = replay.rows[0];
        if (prior !== undefined) {
          if (prior.start_request_hash !== requestHash)
            throw new SpacesRouteAttachmentRefused("conflict");
          return stateResponse(prior, true);
        }
        // An ineffective old binding is not an empty slot: a community that
        // ever held a route, and a root that ever addressed one, stay taken.
        const taken = await query(
          tx,
          "spaces-route.start.taken",
          `SELECT EXISTS (SELECT 1 FROM community_canonical_route_bindings
                           WHERE family='spaces' AND root_label=$1) AS root_bound`,
          [input.canonicalRoot],
        );
        if (
          community.canonical_route_binding_id !== null ||
          community.ever_bound !== false ||
          taken.rows[0]?.root_bound !== false
        ) {
          throw new SpacesRouteAttachmentRefused("conflict");
        }
        const open = await query(
          tx,
          "spaces-route.start.open",
          `${SELECT_ATTACHMENT}
            WHERE attachment.status = ANY($3::text[])
              AND (attachment.community_id=$1
                OR (attachment.environment=$4 AND attachment.canonical_root=$2))
            FOR UPDATE OF attachment`,
          [input.communityId, input.canonicalRoot, OPEN, environment],
        );
        for (const row of open.rows) {
          if (row.live === true) throw new SpacesRouteAttachmentRefused("conflict");
          await finish(tx, row, "expired");
        }
        let observed: Awaited<ReturnType<SpacesRootRouteObserver["observe"]>>;
        try {
          observed = await observer.observe({ canonicalRoot: input.canonicalRoot });
        } catch {
          return pending;
        }
        if (observed.kind === "pending") return pending;
        const evidence = observed.evidence;
        const attachmentIntentId = `sroute_${hexId()}`;
        const ceremonyIntentId = `srcer_${hexId()}`;
        const nonceHex = Buffer.from(randomBytes(32)).toString("hex");
        const requirementHash = spacesRouteRequirementHashV1({
          environment,
          communityId: input.communityId,
          canonicalRoot: input.canonicalRoot,
          publicOrigin,
        });
        const allocated = await query(
          tx,
          "spaces-route.start.allocate",
          `SELECT clock_timestamp() AS created_at,
                  clock_timestamp() + make_interval(secs => $3) AS expires_at,
                  COALESCE(MAX(generation),0)+1 AS generation
             FROM spaces_community_route_attachments
            WHERE environment=$1 AND canonical_root=$2`,
          [environment, input.canonicalRoot, SPACES_ROUTE_CHALLENGE_SECONDS],
        );
        const slot = allocated.rows[0];
        if (slot === undefined) throw new Error("Invalid Spaces route allocation");
        const generation = number(slot.generation);
        const createdAt = iso(slot.created_at);
        const expiresAt = iso(slot.expires_at);
        const challengeMessage = spacesRouteOwnerMessageV1({
          environment,
          actorId: input.accountId,
          communityId: input.communityId,
          attachmentIntentId,
          ceremonyIntentId,
          generation,
          canonicalRoot: input.canonicalRoot,
          rootOutpoint: evidence.outpoint,
          ownerPublicKeyHex: evidence.owner_xonly_key_hex,
          publicOrigin,
          providerConfigurationDigest,
          requirementHash,
          nonceHex,
          expiresAt,
        });
        const inserted = await query(
          tx,
          "spaces-route.start.insert",
          `WITH created AS (
             INSERT INTO spaces_community_route_attachments (
               attachment_intent_id,ceremony_intent_id,generation,environment,canonical_root,
               community_id,account_id,start_idempotency_key,start_request_hash,nonce_hex,
               root_outpoint,root_key_hex,public_origin,canonical_href,provider_id,
               provider_configuration_digest,requirement_hash,challenge_message,
               challenge_digest_hex,start_observation,start_observation_sha256_hex,
               created_at,expires_at,status,updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               $21,$22::timestamptz,$23::timestamptz,'awaiting_signature',$22::timestamptz)
             RETURNING *)
           SELECT created.*, created.expires_at > clock_timestamp() AS live FROM created`,
          [
            attachmentIntentId,
            ceremonyIntentId,
            generation,
            environment,
            input.canonicalRoot,
            input.communityId,
            input.accountId,
            input.idempotencyKey,
            requestHash,
            nonceHex,
            evidence.outpoint,
            evidence.owner_xonly_key_hex,
            publicOrigin,
            spacesRouteCanonicalHrefV1(publicOrigin, input.canonicalRoot),
            SPACES_ROUTE_PROVIDER_ID,
            providerConfigurationDigest,
            requirementHash,
            challengeMessage,
            spacesOwnerChallengeDigestV1(challengeMessage),
            observed.bytes,
            sha256(observed.bytes),
            createdAt,
            expiresAt,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error("Invalid Spaces route attachment insert");
        return stateResponse(row, false);
      });
    },
    current: async (input) =>
      transact(db, async (tx) => {
        await lockAuthorizedCommunity(tx, input.accountId, input.communityId);
        const result = await query(
          tx,
          "spaces-route.current",
          `${SELECT_ATTACHMENT}
            WHERE attachment.community_id=$1 AND attachment.environment=$2
            ORDER BY attachment.created_at DESC, attachment.attachment_intent_id DESC LIMIT 1`,
          [input.communityId, environment],
        );
        const row = result.rows[0];
        if (row === undefined) throw new SpacesRouteAttachmentRefused("not_found");
        return stateResponse(row, true);
      }),
    prove: async (input) =>
      transact(db, async (tx) => {
        const row = await loadOwned(tx, input, environment);
        if (row.status === "proved" || row.status === "committed") {
          // The same signature replays; another cannot replace a stored proof.
          if (row.signature_hex !== input.signatureHex)
            throw new SpacesRouteAttachmentRefused("conflict");
          return stateResponse(row, true);
        }
        if (row.status !== "awaiting_signature") return stateResponse(row, true);
        if (row.live !== true) return finish(tx, row, "expired");
        const digest = text(row.challenge_digest_hex);
        if (!spacesOwnerSignatureValidV1(digest, text(row.root_key_hex), input.signatureHex))
          return finish(tx, row, "signature_rejected");
        const root = text(row.canonical_root);
        const drifted = (evidence: { outpoint: string; owner_xonly_key_hex: string }) =>
          evidence.outpoint !== row.root_outpoint ||
          evidence.owner_xonly_key_hex !== row.root_key_hex;
        let observed: Awaited<ReturnType<SpacesRootRouteObserver["observe"]>>;
        try {
          observed = await observer.observe({
            canonicalRoot: root,
            digestHex: digest,
            signatureHex: input.signatureHex,
          });
        } catch {
          return pending;
        }
        if (observed.kind === "pending") {
          // The verifier refuses a signature made by a key that no longer owns
          // the root. Only a successful unsigned read can assert that drift.
          try {
            const unsigned = await observer.observe({ canonicalRoot: root });
            if (unsigned.kind === "verified" && drifted(unsigned.evidence))
              return finish(tx, row, "root_changed");
          } catch {
            /* An unavailable observation cannot assert drift. */
          }
          return pending;
        }
        if (drifted(observed.evidence)) return finish(tx, row, "root_changed");
        // The row guard refuses this update once the challenge has expired by
        // the database clock, however long the observation took.
        const proved = await query(
          tx,
          "spaces-route.prove.store",
          `WITH changed AS (
             UPDATE spaces_community_route_attachments
                SET status='proved',signature_hex=$2,proof_observation=$3,
                    proof_observation_sha256_hex=$4,proved_at=date_trunc('milliseconds',clock_timestamp()),
                    updated_at=clock_timestamp()
              WHERE attachment_intent_id=$1 AND status='awaiting_signature'
                AND expires_at > clock_timestamp()
              RETURNING *)
           SELECT changed.*, changed.expires_at > clock_timestamp() AS live FROM changed`,
          [row.attachment_intent_id, input.signatureHex, observed.bytes, sha256(observed.bytes)],
        );
        const stored = proved.rows[0];
        if (stored === undefined) return finish(tx, row, "expired");
        return stateResponse(stored, false);
      }),
    commit: async (input) =>
      transact(db, async (tx) => {
        const row = await loadOwned(tx, input, environment);
        if (number(row.generation) !== input.generation)
          throw new SpacesRouteAttachmentRefused("conflict");
        if (row.status === "committed") {
          if (typeof row.committed_response !== "object" || row.committed_response === null)
            throw new Error("Missing Spaces route commit response");
          return { ...row.committed_response, replayed: true };
        }
        if (row.status !== "proved") throw new SpacesRouteAttachmentRefused("conflict");
        if (row.live !== true) return finish(tx, row, "expired");
        const root = text(row.canonical_root);
        const ownerIdentityDigest = spacesRouteOwnerIdentityDigestV1({
          canonicalRoot: root,
          rootOutpoint: text(row.root_outpoint),
          ownerPublicKeyHex: text(row.root_key_hex),
        });
        const lease = await query(
          tx,
          "spaces-route.commit.lease",
          `SELECT proved_at, proved_at + make_interval(secs => $2) AS expires_at
             FROM spaces_community_route_attachments WHERE attachment_intent_id=$1`,
          [row.attachment_intent_id, SPACES_ROUTE_EVIDENCE_LEASE_SECONDS],
        );
        const verifiedAt = iso(lease.rows[0]?.proved_at);
        const expiresAt = iso(lease.rows[0]?.expires_at);
        const evidenceRef = `srevid_${hexId()}`;
        const routeBindingId = `srbind_${hexId()}`;
        // The evidence and binding guards recheck, under their own locks and
        // the database clock, that the proof is live, the actor still holds
        // route authority and the community has never been bound.
        await query(
          tx,
          "spaces-route.commit.evidence",
          `INSERT INTO community_route_ownership_evidence (
             evidence_ref,verified_by_actor_id,family,root_label,root_label_display,path_segment,
             requirement_hash,provider_id,provider_binding_hash,provider_configuration_version,
             provider_identity_digest,evidence_digest,binding_generation,verified_at,expires_at,
             origin,spaces_route_attachment_intent_id
           ) VALUES ($1,$2,'spaces',$3,$3,'@'||$3,$4,$5,$6,$7,$8,$9,1,$10::timestamptz,
             $11::timestamptz,'spaces_route_attachment',$12)`,
          [
            evidenceRef,
            input.accountId,
            root,
            row.requirement_hash,
            SPACES_ROUTE_PROVIDER_ID,
            row.provider_configuration_digest,
            SPACES_ROUTE_VERIFIER_CONTRACT,
            ownerIdentityDigest,
            spacesRouteEvidenceDigestV1({
              kind: "attachment",
              reference: text(row.attachment_intent_id),
              bindingGeneration: 1,
              ownerIdentityDigest,
              observationSha256Hex: text(row.proof_observation_sha256_hex),
              challengeDigestHex: text(row.challenge_digest_hex),
              signatureHex: text(row.signature_hex),
              verifiedAt,
              expiresAt,
            }),
            verifiedAt,
            expiresAt,
            row.attachment_intent_id,
          ],
        );
        await query(
          tx,
          "spaces-route.commit.binding",
          `INSERT INTO community_canonical_route_bindings (
             route_binding_id,community_id,family,root_label,root_label_display,
             ownership_status,route_lifecycle_status,binding_generation,
             verified_evidence_ref,route_authority_kind
           ) VALUES ($1,$2,'spaces',$3,$3,'verified','active',1,$4,'verified_namespace_v1')`,
          [routeBindingId, input.communityId, root, evidenceRef],
        );
        const bound = await query(
          tx,
          "spaces-route.commit.community",
          `UPDATE communities SET canonical_route_binding_id=$1,updated_at=clock_timestamp()
            WHERE community_id=$2 AND canonical_route_binding_id IS NULL
              AND status='active' AND route_authority_version='optional_route_v2'`,
          [routeBindingId, input.communityId],
        );
        if (bound.rowCount !== 1) throw new SpacesRouteAttachmentRefused("conflict");
        const response = {
          ...stateResponse(
            { ...row, status: "committed", route_binding_id: routeBindingId },
            false,
          ),
          route_expires_at: expiresAt,
        };
        await query(
          tx,
          "spaces-route.commit.attachment",
          `UPDATE spaces_community_route_attachments
              SET status='committed',route_binding_id=$2,evidence_ref=$3,
                  committed_response=$4::jsonb,updated_at=clock_timestamp()
            WHERE attachment_intent_id=$1 AND status='proved'`,
          [row.attachment_intent_id, routeBindingId, evidenceRef, JSON.stringify(response)],
        );
        return response;
      }),
  };
}

export type SpacesRouteRenewalOutcome = Readonly<{
  routeBindingId: string;
  outcome: "renewed" | "owner_changed" | "unavailable" | "stale";
}>;

/**
 * Re-observes live Spaces bindings whose evidence is old enough to renew. An
 * unchanged owner extends the lease with a new evidence row. A changed
 * outpoint or key suspends only that binding. An unavailable verifier does
 * nothing: the lease then runs out and the address fails closed at read time
 * with no help from this job.
 */
export async function renewDueSpacesRouteBindings(
  options: Readonly<{
    db: ControlPlaneDb["Service"];
    observer: SpacesRootRouteObserver;
    limit: number;
  }>,
): Promise<readonly SpacesRouteRenewalOutcome[]> {
  const { db, observer } = options;
  const due = await transact(db, async (tx) =>
    query(
      tx,
      "spaces-route.renewal.due",
      `SELECT binding.route_binding_id,binding.root_label,binding.binding_generation
         FROM community_canonical_route_bindings AS binding
         JOIN community_route_ownership_evidence AS evidence
           ON evidence.evidence_ref=binding.verified_evidence_ref
        WHERE binding.family='spaces' AND binding.route_lifecycle_status='active'
          AND binding.ownership_status='verified'
          AND evidence.expires_at > clock_timestamp()
          AND evidence.verified_at <= clock_timestamp() - make_interval(secs => $1)
        ORDER BY evidence.expires_at, binding.route_binding_id LIMIT $2`,
      [SPACES_ROUTE_RENEW_AFTER_SECONDS, options.limit],
    ),
  );
  const outcomes: SpacesRouteRenewalOutcome[] = [];
  for (const candidate of due.rows) {
    const routeBindingId = text(candidate.route_binding_id);
    const root = text(candidate.root_label);
    let observed: Awaited<ReturnType<SpacesRootRouteObserver["observe"]>>;
    try {
      observed = await observer.observe({ canonicalRoot: root });
    } catch {
      outcomes.push({ routeBindingId, outcome: "unavailable" });
      continue;
    }
    if (observed.kind === "pending") {
      outcomes.push({ routeBindingId, outcome: "unavailable" });
      continue;
    }
    const { bytes, evidence } = observed;
    const outcome = await transact(db, async (tx) => {
      const locked = await query(
        tx,
        "spaces-route.renewal.lock",
        `SELECT binding.binding_generation,evidence.requirement_hash,evidence.provider_id,
                evidence.provider_binding_hash,evidence.provider_configuration_version,
                evidence.provider_identity_digest
           FROM community_canonical_route_bindings AS binding
           JOIN community_route_ownership_evidence AS evidence
             ON evidence.evidence_ref=binding.verified_evidence_ref
          WHERE binding.route_binding_id=$1 AND binding.family='spaces'
            AND binding.route_lifecycle_status='active' AND binding.ownership_status='verified'
            AND binding.binding_generation=$2 AND evidence.expires_at > clock_timestamp()
          FOR UPDATE OF binding`,
        [routeBindingId, candidate.binding_generation],
      );
      const current = locked.rows[0];
      if (current === undefined) return "stale" as const;
      const generation = number(current.binding_generation);
      const ownerIdentityDigest = spacesRouteOwnerIdentityDigestV1({
        canonicalRoot: root,
        rootOutpoint: evidence.outpoint,
        ownerPublicKeyHex: evidence.owner_xonly_key_hex,
      });
      const unchanged = ownerIdentityDigest === current.provider_identity_digest;
      const renewalId = `srenew_${hexId()}`;
      const observationDigest = sha256(bytes);
      const recorded = await query(
        tx,
        "spaces-route.renewal.record",
        `INSERT INTO spaces_community_route_renewals (
           renewal_id,route_binding_id,expected_binding_generation,outcome,root_outpoint,
           root_key_hex,observation,observation_sha256_hex,observed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,date_trunc('milliseconds',clock_timestamp()))
         RETURNING observed_at, observed_at + make_interval(secs => $9) AS expires_at`,
        [
          renewalId,
          routeBindingId,
          generation,
          unchanged ? "renewed" : "owner_changed",
          evidence.outpoint,
          evidence.owner_xonly_key_hex,
          bytes,
          observationDigest,
          SPACES_ROUTE_EVIDENCE_LEASE_SECONDS,
        ],
      );
      if (!unchanged) {
        await query(
          tx,
          "spaces-route.renewal.suspend",
          `UPDATE community_canonical_route_bindings
              SET verified_evidence_ref=NULL,ownership_status='revoked',
                  route_lifecycle_status='suspended',binding_generation=binding_generation+1,
                  updated_at=clock_timestamp()
            WHERE route_binding_id=$1 AND binding_generation=$2`,
          [routeBindingId, generation],
        );
        return "owner_changed" as const;
      }
      const verifiedAt = iso(recorded.rows[0]?.observed_at);
      const expiresAt = iso(recorded.rows[0]?.expires_at);
      const evidenceRef = `srevid_${hexId()}`;
      await query(
        tx,
        "spaces-route.renewal.evidence",
        `INSERT INTO community_route_ownership_evidence (
           evidence_ref,family,root_label,root_label_display,path_segment,requirement_hash,
           provider_id,provider_binding_hash,provider_configuration_version,
           provider_identity_digest,evidence_digest,binding_generation,verified_at,expires_at,
           origin,spaces_route_renewal_id
         ) VALUES ($1,'spaces',$2,$2,'@'||$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,
           $11::timestamptz,'spaces_route_renewal',$12)`,
        [
          evidenceRef,
          root,
          current.requirement_hash,
          current.provider_id,
          current.provider_binding_hash,
          current.provider_configuration_version,
          ownerIdentityDigest,
          spacesRouteEvidenceDigestV1({
            kind: "renewal",
            reference: renewalId,
            bindingGeneration: generation + 1,
            ownerIdentityDigest,
            observationSha256Hex: observationDigest,
            challengeDigestHex: null,
            signatureHex: null,
            verifiedAt,
            expiresAt,
          }),
          generation + 1,
          verifiedAt,
          expiresAt,
          renewalId,
        ],
      );
      await query(
        tx,
        "spaces-route.renewal.advance",
        `UPDATE community_canonical_route_bindings
            SET verified_evidence_ref=$3,binding_generation=binding_generation+1,
                updated_at=clock_timestamp()
          WHERE route_binding_id=$1 AND binding_generation=$2`,
        [routeBindingId, generation, evidenceRef],
      );
      return "renewed" as const;
    });
    outcomes.push({ routeBindingId, outcome });
  }
  return outcomes;
}
