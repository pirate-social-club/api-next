import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ControlPlaneDb, ControlPlaneTransaction } from "@pirate/application";
import { SpacesOwnerProofRefused } from "@pirate/contracts";
import { isCanonicalSpacesRootV1 } from "@pirate/domain";
import { Effect } from "effect";
import {
  spacesOwnerChallengeDigestV1,
  spacesOwnerChallengeMessageV1,
  spacesOwnerPollRequestHashV1,
  spacesOwnerSignatureValidV1,
  spacesOwnerStartRequestHashV1,
} from "./spaces-owner-proof-codec.ts";
import type { SpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hexId = () => randomUUID().replaceAll("-", "");
const raw = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const iso = (value: unknown): string => new Date(value as string).toISOString();
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Invalid Spaces ceremony row");
  return value;
};
const number = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid Spaces ceremony row");
  return parsed;
};

type Row = Readonly<Record<string, unknown>>;
type Transaction = ControlPlaneTransaction;

const query = async (tx: Transaction, label: string, sql: string, values: readonly unknown[]) =>
  Effect.runPromise(tx.execute<Row>({ label, text: sql, values, readonly: false }));

const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("Invalid Spaces ceremony cardinality");
  return rows[0];
};

const databaseNow = async (tx: Transaction): Promise<string> =>
  iso(one((await query(tx, "spaces-owner.clock", "SELECT clock_timestamp() AS now", [])).rows).now);

const transact = <T>(
  db: ControlPlaneDb["Service"],
  action: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  Effect.runPromise(
    db.withTransaction((tx) => Effect.tryPromise({ try: () => action(tx), catch: (e) => e })),
  );

export type SpacesRootAuthorityObservation =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "verified"; bytes: Uint8Array; evidence: SpacesRootAuthorityEvidenceV1 }>;

export type SpacesRootAuthorityObserver = Readonly<{
  observe: (
    input: Readonly<{
      canonicalRoot: string;
      digestHex?: string;
      signatureHex?: string;
    }>,
  ) => Promise<SpacesRootAuthorityObservation>;
}>;

export type SpacesOwnerProofStore = Readonly<{
  start: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      canonicalRoot: string;
      idempotencyKey: string;
    }>,
  ) => Promise<unknown>;
  poll: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      ceremonyId: string;
      idempotencyKey: string;
      signatureHex: string;
    }>,
  ) => Promise<unknown>;
}>;

const lockRoot = async (tx: Transaction, environment: string, root: string): Promise<void> => {
  await query(
    tx,
    "spaces-owner.root.lock",
    "SELECT pg_advisory_xact_lock(hashtextextended($1,202612))",
    [`${environment}:mainnet:${root}`],
  );
};

const checkAuthority = async (
  tx: Transaction,
  accountId: string,
  communityId: string,
): Promise<void> => {
  const result = await query(
    tx,
    "spaces-owner.sales-authority",
    `
    SELECT authority_grant.grant_id FROM community_handle_sales_authority_grants AS authority_grant
    JOIN communities AS community ON community.community_id=authority_grant.community_id
    WHERE authority_grant.community_id=$1 AND authority_grant.principal_account_id=$2
      AND authority_grant.authority='manage_handle_sales' AND authority_grant.status='active'
      AND community.status='active'
    FOR SHARE OF authority_grant,community`,
    [communityId, accountId],
  );
  if (result.rows.length !== 1) throw new SpacesOwnerProofRefused("forbidden");
};

const checkMainnet = async (tx: Transaction): Promise<void> => {
  const result = await query(
    tx,
    "spaces-owner.network",
    `
    SELECT network FROM spaces_network_configuration
    WHERE configuration_key='spaces_network_v1' FOR SHARE`,
    [],
  );
  if (result.rows.length !== 1 || result.rows[0]?.network !== "mainnet") {
    throw new SpacesOwnerProofRefused("unavailable");
  }
};

const challengeResponse = (row: Row, replayed: boolean) => ({
  contract: "pirate-spaces-ownership-start-v1" as const,
  ceremony_id: text(row.ceremony_id),
  generation: number(row.generation),
  network: "mainnet" as const,
  canonical_root: text(row.canonical_root),
  root_outpoint: text(row.root_outpoint),
  root_key_hex: text(row.root_key_hex),
  challenge_message: text(row.challenge_message),
  challenge_digest_hex: text(row.challenge_digest_hex),
  expires_at: iso(row.expires_at),
  replayed,
});

const terminalResponse = (row: Row, replayed: boolean) => {
  if (typeof row.terminal_response !== "object" || row.terminal_response === null) {
    throw new Error("Missing Spaces ceremony terminal response");
  }
  return { ...row.terminal_response, replayed };
};

const pendingStart = {
  contract: "pirate-spaces-ownership-start-v1",
  status: "verification_pending",
  retry_after_seconds: 30,
} as const;
const pendingPoll = (row: Row) => ({
  contract: "pirate-spaces-ownership-result-v1" as const,
  ceremony_id: text(row.ceremony_id),
  generation: number(row.generation),
  status: "verification_pending" as const,
  retry_after_seconds: 30,
  replayed: false as const,
});

const rejectedPoll = (row: Row, status: "expired" | "root_changed" | "signature_rejected") => ({
  contract: "pirate-spaces-ownership-result-v1" as const,
  ceremony_id: text(row.ceremony_id),
  generation: number(row.generation),
  status,
  replayed: false,
});

const finishPoll = async (
  tx: Transaction,
  row: Row,
  pollId: string,
  response: unknown,
  now: string,
): Promise<unknown> => {
  await query(
    tx,
    "spaces-owner.ceremony.finish",
    `
    UPDATE spaces_owner_proof_ceremonies SET status=$2, terminal_response=$3::jsonb,updated_at=$4::timestamptz
    WHERE ceremony_id=$1`,
    [row.ceremony_id, (response as { status: string }).status, JSON.stringify(response), now],
  );
  await query(
    tx,
    "spaces-owner.poll.finish",
    `
    UPDATE spaces_owner_proof_polls SET terminal_response=$2::jsonb,updated_at=$3::timestamptz
    WHERE poll_id=$1`,
    [pollId, JSON.stringify(response), now],
  );
  return response;
};

export function makeSpacesOwnerProofStore(
  options: Readonly<{
    db: ControlPlaneDb["Service"];
    observer: SpacesRootAuthorityObserver;
    environment: "development" | "staging" | "production";
  }>,
): SpacesOwnerProofStore {
  const { db, observer, environment } = options;
  return {
    start: async (input) => {
      if (!isCanonicalSpacesRootV1(input.canonicalRoot))
        throw new SpacesOwnerProofRefused("invalid");
      return transact(db, async (tx) => {
        await lockRoot(tx, environment, input.canonicalRoot);
        await checkMainnet(tx);
        await checkAuthority(tx, input.accountId, input.communityId);
        const requestBytes = raw({
          idempotency_key: input.idempotencyKey,
          canonical_root: input.canonicalRoot,
        });
        const requestHash = spacesOwnerStartRequestHashV1({ environment, ...input });
        const replay = await query(
          tx,
          "spaces-owner.start.replay",
          `
          SELECT * FROM spaces_owner_proof_ceremonies
          WHERE account_id=$1 AND community_id=$2 AND canonical_root=$3 AND start_idempotency_key=$4
          FOR UPDATE`,
          [input.accountId, input.communityId, input.canonicalRoot, input.idempotencyKey],
        );
        if (replay.rows.length > 0) {
          const prior = one(replay.rows);
          if (
            prior.start_request_hash !== requestHash ||
            !Buffer.from(prior.start_request_bytes as Uint8Array).equals(requestBytes)
          ) {
            throw new SpacesOwnerProofRefused("conflict");
          }
          return challengeResponse(prior, true);
        }
        const current = await query(
          tx,
          "spaces-owner.current",
          `
          SELECT * FROM spaces_owner_proof_ceremonies
          WHERE environment=$1 AND canonical_root=$2 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
          [environment, input.canonicalRoot],
        );
        const previous = current.rows[0];
        const firstNow = await databaseNow(tx);
        if (
          previous?.status === "pending" &&
          new Date(iso(previous.expires_at)) > new Date(firstNow)
        ) {
          throw new SpacesOwnerProofRefused("conflict");
        }
        if (previous?.status === "pending") {
          await query(
            tx,
            "spaces-owner.previous.expire",
            `
            UPDATE spaces_owner_proof_ceremonies
            SET status='expired',terminal_response=$2::jsonb,updated_at=$3::timestamptz
            WHERE ceremony_id=$1`,
            [previous.ceremony_id, JSON.stringify(rejectedPoll(previous, "expired")), firstNow],
          );
        }
        let observed: SpacesRootAuthorityObservation;
        try {
          observed = await observer.observe({ canonicalRoot: input.canonicalRoot });
        } catch {
          return pendingStart;
        }
        if (observed.kind === "pending") return pendingStart;
        const evidence = observed.evidence;
        const generation = previous === undefined ? 1 : number(previous.generation) + 1;
        const ceremonyId = `sowner_${hexId()}`;
        const nonceHex = Buffer.from(randomBytes(32)).toString("hex");
        const createdAt = await databaseNow(tx);
        const expiresAt = new Date(new Date(createdAt).getTime() + 600_000).toISOString();
        const keyLastChangedAt =
          previous !== undefined &&
          previous.root_key_hex === evidence.owner_xonly_key_hex &&
          previous.root_outpoint === evidence.outpoint
            ? iso(previous.key_last_changed_at)
            : firstNow;
        const challengeMessage = spacesOwnerChallengeMessageV1({
          environment,
          canonicalRoot: input.canonicalRoot,
          communityId: input.communityId,
          ceremonyId,
          generation,
          nonceHex,
          rootOutpoint: evidence.outpoint,
          rootKeyHex: evidence.owner_xonly_key_hex,
          expiresAt,
        });
        const inserted = await query(
          tx,
          "spaces-owner.start.insert",
          `
          INSERT INTO spaces_owner_proof_ceremonies (
            ceremony_id,generation,environment,canonical_root,community_id,account_id,
            start_idempotency_key,start_request_bytes,start_request_hash,nonce_hex,root_outpoint,
            root_key_hex,challenge_message,challenge_digest_hex,start_verifier_bytes,
            start_verifier_sha256_hex,key_last_changed_at,anchored_at,publication_verified_at,
            created_at,expires_at,status,updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            $17::timestamptz,$18::timestamptz,$19::timestamptz,$20::timestamptz,$21::timestamptz,
            'pending',$20::timestamptz) RETURNING *`,
          [
            ceremonyId,
            generation,
            environment,
            input.canonicalRoot,
            input.communityId,
            input.accountId,
            input.idempotencyKey,
            requestBytes,
            requestHash,
            nonceHex,
            evidence.outpoint,
            evidence.owner_xonly_key_hex,
            challengeMessage,
            spacesOwnerChallengeDigestV1(challengeMessage),
            observed.bytes,
            sha256(observed.bytes),
            keyLastChangedAt,
            firstNow,
            firstNow,
            createdAt,
            expiresAt,
          ],
        );
        return challengeResponse(one(inserted.rows), false);
      });
    },
    poll: async (input) =>
      transact(db, async (tx) => {
        const preliminary = await query(
          tx,
          "spaces-owner.poll.root",
          `
        SELECT environment,canonical_root FROM spaces_owner_proof_ceremonies WHERE ceremony_id=$1`,
          [input.ceremonyId],
        );
        if (preliminary.rows.length !== 1) throw new SpacesOwnerProofRefused("not_found");
        const root = text(preliminary.rows[0]?.canonical_root);
        await lockRoot(tx, environment, root);
        await checkMainnet(tx);
        await checkAuthority(tx, input.accountId, input.communityId);
        const result = await query(
          tx,
          "spaces-owner.poll.read",
          `
        SELECT * FROM spaces_owner_proof_ceremonies WHERE ceremony_id=$1 FOR UPDATE`,
          [input.ceremonyId],
        );
        const row = one(result.rows);
        if (
          row.environment !== environment ||
          row.account_id !== input.accountId ||
          row.community_id !== input.communityId
        ) {
          throw new SpacesOwnerProofRefused("forbidden");
        }
        const requestBytes = raw({
          ceremony_id: input.ceremonyId,
          idempotency_key: input.idempotencyKey,
          signature_hex: input.signatureHex,
        });
        const requestHash = spacesOwnerPollRequestHashV1({
          ceremonyId: input.ceremonyId,
          generation: number(row.generation),
          idempotencyKey: input.idempotencyKey,
          signatureHex: input.signatureHex,
        });
        const priorPoll = await query(
          tx,
          "spaces-owner.poll.replay",
          `
        SELECT * FROM spaces_owner_proof_polls WHERE ceremony_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.ceremonyId, input.idempotencyKey],
        );
        let pollId: string;
        if (priorPoll.rows.length > 0) {
          const prior = one(priorPoll.rows);
          if (
            prior.request_hash !== requestHash ||
            !Buffer.from(prior.request_bytes as Uint8Array).equals(requestBytes)
          ) {
            throw new SpacesOwnerProofRefused("conflict");
          }
          if (prior.terminal_response !== null) return terminalResponse(prior, true);
          pollId = text(prior.poll_id);
          if (number(prior.attempt_count) >= 8) return pendingPoll(row);
        } else {
          pollId = `sopoll_${hexId()}`;
          const created = await databaseNow(tx);
          await query(
            tx,
            "spaces-owner.poll.insert",
            `
          INSERT INTO spaces_owner_proof_polls
          (poll_id,ceremony_id,account_id,idempotency_key,request_bytes,request_hash,signature_hex,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz)`,
            [
              pollId,
              input.ceremonyId,
              input.accountId,
              input.idempotencyKey,
              requestBytes,
              requestHash,
              input.signatureHex,
              created,
            ],
          );
        }
        const now = await databaseNow(tx);
        // Only the exact poll that completed a ceremony can replay its result.
        // A new poll key must never rewrite a terminal outcome.
        if (row.status !== "pending") throw new SpacesOwnerProofRefused("conflict");
        if (new Date(now) >= new Date(iso(row.expires_at))) {
          return finishPoll(tx, row, pollId, rejectedPoll(row, "expired"), now);
        }
        if (
          !spacesOwnerSignatureValidV1(
            text(row.challenge_digest_hex),
            text(row.root_key_hex),
            input.signatureHex,
          )
        ) {
          return finishPoll(tx, row, pollId, rejectedPoll(row, "signature_rejected"), now);
        }
        await query(
          tx,
          "spaces-owner.poll.attempt",
          `
        UPDATE spaces_owner_proof_polls SET attempt_count=attempt_count+1,updated_at=$2::timestamptz WHERE poll_id=$1`,
          [pollId, now],
        );
        let observed: SpacesRootAuthorityObservation;
        try {
          observed = await observer.observe({
            canonicalRoot: root,
            digestHex: text(row.challenge_digest_hex),
            signatureHex: input.signatureHex,
          });
        } catch {
          return pendingPoll(row);
        }
        if (observed.kind === "pending") {
          try {
            const unsigned = await observer.observe({ canonicalRoot: root });
            if (
              unsigned.kind === "verified" &&
              (unsigned.evidence.outpoint !== row.root_outpoint ||
                unsigned.evidence.owner_xonly_key_hex !== row.root_key_hex)
            ) {
              return finishPoll(tx, row, pollId, rejectedPoll(row, "root_changed"), now);
            }
          } catch {
            /* An unavailable observation cannot assert drift. */
          }
          return pendingPoll(row);
        }
        const evidence = observed.evidence;
        if (
          evidence.outpoint !== row.root_outpoint ||
          evidence.owner_xonly_key_hex !== row.root_key_hex
        ) {
          return finishPoll(tx, row, pollId, rejectedPoll(row, "root_changed"), now);
        }
        const observedAt = await databaseNow(tx);
        const freshUntil = new Date(new Date(observedAt).getTime() + 600_000).toISOString();
        const authority = await query(
          tx,
          "spaces-owner.authority.generation",
          `
        SELECT namespace_authority_reference,namespace_authority_generation
        FROM spaces_namespace_authority_evidence WHERE network='mainnet' AND canonical_root=$1
        ORDER BY namespace_authority_generation DESC LIMIT 1 FOR SHARE`,
          [root],
        );
        const prior = authority.rows[0];
        const authorityReference =
          prior === undefined ? `snauth_${hexId()}` : text(prior.namespace_authority_reference);
        const authorityGeneration =
          prior === undefined ? 1 : number(prior.namespace_authority_generation) + 1;
        const nonceDigest = sha256(Buffer.from(text(row.nonce_hex), "hex"));
        const observationDigest = sha256(observed.bytes);
        const digest = sha256(
          JSON.stringify([
            "pirate-spaces-root-evidence-v1",
            environment,
            "mainnet",
            authorityGeneration,
            root,
            input.communityId,
            input.accountId,
            evidence.outpoint,
            evidence.owner_xonly_key_hex,
            evidence.proof_anchor_block_hash,
            evidence.proof_anchor_height,
            evidence.proof_root_anchor_id_hex,
            evidence.certificate_anchor_block_hash,
            evidence.certificate_anchor_height,
            evidence.certificate_root_anchor_id_hex,
            iso(row.anchored_at),
            iso(row.key_last_changed_at),
            nonceDigest,
            observedAt,
            iso(row.publication_verified_at),
            observationDigest,
            observedAt,
            freshUntil,
          ]),
        );
        await query(
          tx,
          "spaces-owner.authority.insert",
          `
        INSERT INTO spaces_namespace_authority_evidence (
          namespace_authority_reference,namespace_authority_generation,evidence_digest,network,
          canonical_root,display_root,community_id,controlling_account_id,challenge_environment,
          challenge_nonce_digest,root_outpoint,root_key_hex,anchor_block_hash,anchor_height,
          anchored_at,key_last_changed_at,challenge_completed_at,publication_verified_at,
          observed_at,fresh_until,raw_verifier_evidence
        ) VALUES ($1,$2,$3,'mainnet',$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13::timestamptz,$14::timestamptz,$15::timestamptz,$16::timestamptz,
          $17::timestamptz,$18::timestamptz,$19)`,
          [
            authorityReference,
            authorityGeneration,
            digest,
            root,
            input.communityId,
            input.accountId,
            environment,
            nonceDigest,
            evidence.outpoint,
            evidence.owner_xonly_key_hex,
            evidence.proof_anchor_block_hash,
            evidence.proof_anchor_height,
            iso(row.anchored_at),
            iso(row.key_last_changed_at),
            observedAt,
            iso(row.publication_verified_at),
            observedAt,
            freshUntil,
            observed.bytes,
          ],
        );
        await query(
          tx,
          "spaces-owner.authority.provenance",
          `
        INSERT INTO spaces_owner_proof_evidence (
          namespace_authority_reference,namespace_authority_generation,ceremony_id,
          proof_anchor_height,proof_anchor_block_hash,proof_root_anchor_id_hex,
          certificate_anchor_height,certificate_anchor_block_hash,certificate_root_anchor_id_hex,
          observation_sha256_hex,observed_at,fresh_until
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz)`,
          [
            authorityReference,
            authorityGeneration,
            input.ceremonyId,
            evidence.proof_anchor_height,
            evidence.proof_anchor_block_hash,
            evidence.proof_root_anchor_id_hex,
            evidence.certificate_anchor_height,
            evidence.certificate_anchor_block_hash,
            evidence.certificate_root_anchor_id_hex,
            observationDigest,
            observedAt,
            freshUntil,
          ],
        );
        const response = {
          contract: "pirate-spaces-ownership-result-v1" as const,
          ceremony_id: input.ceremonyId,
          generation: number(row.generation),
          status: "verified" as const,
          namespace_authority_reference: authorityReference,
          namespace_authority_generation: authorityGeneration,
          evidence_digest_hex: digest,
          observed_at: observedAt,
          fresh_until: freshUntil,
          replayed: false,
        };
        return finishPoll(tx, row, pollId, response, observedAt);
      }),
  };
}
