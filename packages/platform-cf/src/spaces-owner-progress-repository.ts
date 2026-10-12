import type { ControlPlaneDb } from "@pirate/application";
import {
  SpacesOwnerProofRefused,
  SpacesOwnershipProgressV1,
  SpacesOwnershipRootsV1,
} from "@pirate/contracts";
import { isCanonicalSpacesRootV1 } from "@pirate/domain";
import { Schema } from "effect";
import {
  challengeResponse,
  checkAuthority,
  checkMainnet,
  databaseNow,
  iso,
  lockRoot,
  number,
  one,
  query,
  terminalResponse,
  text,
  transact,
} from "./spaces-owner-proof-persistence.ts";
import type {
  SpacesOwnerProofStore,
  SpacesRootAuthorityObserver,
} from "./spaces-owner-proof-repository.ts";

export async function listSpacesOwnershipRoots(
  db: ControlPlaneDb["Service"],
  environment: "development" | "staging" | "production",
  input: Parameters<SpacesOwnerProofStore["list"]>[0],
): Promise<SpacesOwnershipRootsV1> {
  if (input.cursor !== undefined && !isCanonicalSpacesRootV1(input.cursor))
    throw new SpacesOwnerProofRefused("invalid");
  return transact(db, async (tx) => {
    await checkMainnet(tx);
    await checkAuthority(tx, input.accountId, input.communityId);
    const result = await query(
      tx,
      "spaces-owner.progress.roots",
      `
      SELECT DISTINCT canonical_root COLLATE "C" AS canonical_root
      FROM spaces_owner_proof_ceremonies
      WHERE environment=$1 AND network='mainnet' AND account_id=$2 AND community_id=$3
        AND ($4::text IS NULL OR canonical_root COLLATE "C" > $4::text COLLATE "C")
      ORDER BY canonical_root LIMIT 21`,
      [environment, input.accountId, input.communityId, input.cursor ?? null],
    );
    const items = result.rows
      .slice(0, 20)
      .map((row) => ({ canonical_root: text(row.canonical_root) }));
    return Schema.decodeUnknownSync(SpacesOwnershipRootsV1)({
      items,
      next_cursor: result.rows.length > 20 ? items.at(-1)?.canonical_root : null,
    });
  });
}

const rejectedPoll = (row: Parameters<typeof challengeResponse>[0], status: "expired") => ({
  contract: "pirate-spaces-ownership-result-v1" as const,
  ceremony_id: text(row.ceremony_id),
  generation: number(row.generation),
  status,
  replayed: false,
});

export function makeSpacesOwnerProgressReader(
  options: Readonly<{
    db: ControlPlaneDb["Service"];
    observer: SpacesRootAuthorityObserver;
    environment: "development" | "staging" | "production";
  }>,
): SpacesOwnerProofStore["current"] {
  const { db, observer, environment } = options;
  return async (input) => {
    if (!isCanonicalSpacesRootV1(input.canonicalRoot)) throw new SpacesOwnerProofRefused("invalid");
    return transact(db, async (tx) => {
      // Serialize with admission and poll. An empty read after a lost start
      // response must not race an admission that is still committing.
      await lockRoot(tx, environment, input.canonicalRoot);
      await checkMainnet(tx);
      await checkAuthority(tx, input.accountId, input.communityId);
      let now = await databaseNow(tx);
      const rows = await query(
        tx,
        "spaces-owner.progress.ceremony",
        `
          SELECT ceremony.*,(SELECT max(generation) FROM spaces_owner_proof_ceremonies
            WHERE environment=$1 AND network='mainnet' AND canonical_root=$2) AS latest_generation
          FROM spaces_owner_proof_ceremonies AS ceremony
          WHERE environment=$1 AND network='mainnet' AND canonical_root=$2
            AND account_id=$3 AND community_id=$4
          ORDER BY generation DESC LIMIT 1`,
        [environment, input.canonicalRoot, input.accountId, input.communityId],
      );
      const row = rows.rows[0];
      let ceremony: SpacesOwnershipProgressV1["ceremony"] = null;
      let operatorAssignment: SpacesOwnershipProgressV1["operator_assignment"] = null;
      if (row !== undefined) {
        const challenge = challengeResponse(row, true);
        if (number(row.generation) !== number(row.latest_generation)) {
          ceremony = { status: "superseded", challenge };
        } else if (row.status === "pending") {
          if (new Date(now) >= new Date(iso(row.expires_at))) {
            ceremony = { status: "ended", challenge, result: rejectedPoll(row, "expired") };
          } else {
            const polls = await query(
              tx,
              "spaces-owner.progress.pending-poll",
              `
                SELECT idempotency_key FROM spaces_owner_proof_polls
                WHERE ceremony_id=$1 AND account_id=$2 AND terminal_response IS NULL
                ORDER BY updated_at DESC,poll_id DESC LIMIT 1`,
              [row.ceremony_id, input.accountId],
            );
            ceremony =
              polls.rows[0] === undefined
                ? { status: "awaiting_signature", challenge }
                : {
                    status: "verification_pending",
                    challenge,
                    pending_poll_key: text(polls.rows[0].idempotency_key),
                  };
          }
        } else if (row.status === "verified") {
          const result = Schema.decodeUnknownSync(SpacesOwnershipProgressV1.fields.ceremony)({
            status: "verified",
            challenge,
            result: terminalResponse(row, true),
            proof_status: "unavailable",
          });
          if (result?.status !== "verified") throw new Error("Invalid Spaces proof result");
          const authority = await query(
            tx,
            "spaces-owner.progress.authority",
            `
              SELECT namespace_authority_reference,namespace_authority_generation,community_id,
                controlling_account_id,challenge_environment FROM spaces_namespace_authority_evidence
              WHERE network='mainnet' AND canonical_root=$1
              ORDER BY namespace_authority_generation DESC LIMIT 1`,
            [input.canonicalRoot],
          );
          const current = authority.rows[0];
          let proofStatus: typeof result.proof_status = "unavailable";
          if (
            current === undefined ||
            current.namespace_authority_reference !== result.result.namespace_authority_reference ||
            number(current.namespace_authority_generation) !==
              result.result.namespace_authority_generation ||
            current.community_id !== input.communityId ||
            current.controlling_account_id !== input.accountId ||
            current.challenge_environment !== environment
          ) {
            proofStatus = "superseded";
          } else if (new Date(now) >= new Date(result.result.fresh_until)) {
            proofStatus = "expired";
          } else {
            const observed = await observer
              .observe({ canonicalRoot: input.canonicalRoot })
              .catch(() => null);
            if (
              observed?.kind === "verified" &&
              observed.evidence.network === "mainnet" &&
              observed.evidence.root === `@${input.canonicalRoot}` &&
              observed.evidence.anchor_bound_outpoint
            ) {
              proofStatus =
                observed.evidence.outpoint === row.root_outpoint &&
                observed.evidence.owner_xonly_key_hex === row.root_key_hex
                  ? "fresh"
                  : "root_changed";
            }
            now = await databaseNow(tx);
            if (proofStatus === "fresh" && new Date(now) >= new Date(result.result.fresh_until)) {
              proofStatus = "expired";
            }
          }
          ceremony = { ...result, proof_status: proofStatus };
        } else {
          ceremony = Schema.decodeUnknownSync(SpacesOwnershipProgressV1.fields.ceremony)({
            status: "ended",
            challenge,
            result: terminalResponse(row, true),
          });
        }
        if (ceremony === null) throw new Error("Invalid Spaces progress ceremony");
        // Confirmation uses this global assignment lock. Wait for an
        // unanswered confirmation to commit before projecting its outcome.
        await query(
          tx,
          "spaces-owner.progress.assignment-lock",
          "SELECT pg_advisory_xact_lock(hashtextextended('spaces-operator-assignment',20202))",
          [],
        );
        // A pending challenge alone never authorizes disclosure of an
        // operator address. Retained proof scopes recovery to its owner.
        const assignments =
          ceremony.status === "superseded" ||
          (ceremony.status === "verified" && ceremony.proof_status === "superseded")
            ? { rows: [] }
            : await query(
                tx,
                "spaces-owner.progress.assignment",
                `
            SELECT prepared.*,current.current_generation,current.status AS current_status
            FROM spaces_operator_prepared_assignments AS prepared
            LEFT JOIN spaces_operator_assignment_current AS current
              ON current.operator_assignment_id=prepared.operator_assignment_id
            WHERE prepared.environment=$1 AND prepared.network='mainnet' AND prepared.canonical_root=$2
              AND (prepared.status='prepared' OR prepared.confirmed_by_account_id=$3)
              AND EXISTS (SELECT 1 FROM spaces_namespace_authority_evidence AS authority
                WHERE authority.network='mainnet' AND authority.canonical_root=$2 AND authority.community_id=$4
                  AND authority.controlling_account_id=$3 AND authority.challenge_environment=$1)
            ORDER BY prepared.created_at DESC,prepared.operator_assignment_id DESC LIMIT 1`,
                [environment, input.canonicalRoot, input.accountId, input.communityId],
              );
        const assignment = assignments.rows[0];
        if (assignment !== undefined) {
          operatorAssignment = {
            operator_assignment_id: text(assignment.operator_assignment_id),
            generation: number(assignment.operator_assignment_generation),
            network: "mainnet",
            canonical_root: input.canonicalRoot,
            delegation_address: text(assignment.delegation_address),
            replayed: true,
            status: assignment.status === "prepared" ? "prepared" : "confirmed",
            current:
              assignment.current_status === "active" &&
              number(assignment.current_generation) ===
                number(assignment.operator_assignment_generation),
          };
        }
      }
      return Schema.decodeUnknownSync(SpacesOwnershipProgressV1)({
        contract: "pirate-spaces-ownership-progress-v1",
        network: "mainnet",
        canonical_root: input.canonicalRoot,
        read_at: now,
        ceremony,
        operator_assignment: operatorAssignment,
      });
    });
  };
}

export async function readSpacesOwnerResumeSignature(
  db: ControlPlaneDb["Service"],
  environment: "development" | "staging" | "production",
  input: Parameters<SpacesOwnerProofStore["resume"]>[0],
): Promise<string> {
  return transact(db, async (tx) => {
    await checkMainnet(tx);
    await checkAuthority(tx, input.accountId, input.communityId);
    const result = await query(
      tx,
      "spaces-owner.resume.poll",
      `
          SELECT poll.signature_hex FROM spaces_owner_proof_polls AS poll
          JOIN spaces_owner_proof_ceremonies AS ceremony ON ceremony.ceremony_id=poll.ceremony_id
          WHERE poll.ceremony_id=$1 AND poll.idempotency_key=$2 AND poll.account_id=$3
            AND ceremony.account_id=$3 AND ceremony.community_id=$4 AND ceremony.environment=$5`,
      [input.ceremonyId, input.idempotencyKey, input.accountId, input.communityId, environment],
    );
    if (result.rows.length !== 1) throw new SpacesOwnerProofRefused("not_found");
    return text(one(result.rows).signature_hex);
  });
}
