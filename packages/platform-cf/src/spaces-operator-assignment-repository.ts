import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ControlPlaneDb, ControlPlaneTransaction } from "@pirate/application";
import { SpacesOperatorPrepareRequestV1 } from "@pirate/contracts";
import { isCanonicalSpacesRootV1 } from "@pirate/domain";
import { bech32m } from "@scure/base";
import { Effect, Schema } from "effect";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Tx = ControlPlaneTransaction;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const newId = (prefix: string) => `${prefix}_${Buffer.from(randomBytes(16)).toString("hex")}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
export const spacesDelegationScriptV1 = (address: string): string => {
  try {
    const decoded = bech32m.decode(address as `${string}1${string}`, 120);
    const program = bech32m.fromWords(decoded.words.slice(1));
    if (
      decoded.prefix !== "bcs" ||
      decoded.words[0] !== 1 ||
      program.length !== 32 ||
      bech32m.encode("bcs", decoded.words, 120) !== address
    ) {
      throw new Error("Invalid Spaces address");
    }
    return `5120${Buffer.from(program).toString("hex")}`;
  } catch {
    throw new SpacesOperatorAssignmentRefused("invalid");
  }
};
const str = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Invalid Spaces assignment row");
  return value;
};
const instant = (value: unknown): Date => {
  const parsed = value instanceof Date ? value : new Date(str(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error("Invalid Spaces assignment instant");
  return parsed;
};
const int = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid Spaces assignment row");
  return number;
};
const one = (rows: readonly Row[]): Row => {
  if (rows.length !== 1 || rows[0] === undefined)
    throw new Error("Invalid Spaces assignment cardinality");
  return rows[0];
};
const query = async (tx: Tx, label: string, sql: string, values: readonly unknown[]) =>
  Effect.runPromise(tx.execute<Row>({ label, text: sql, values, readonly: false }));
const transact = <T>(db: ControlPlaneDb["Service"], action: (tx: Tx) => Promise<T>) =>
  Effect.runPromise(
    db.withTransaction((tx) => Effect.tryPromise({ try: () => action(tx), catch: (e) => e })),
  );

export class SpacesOperatorAssignmentRefused extends Error {
  constructor(
    readonly reason:
      | "invalid"
      | "unauthorized"
      | "forbidden"
      | "conflict"
      | "unavailable"
      | "not_found",
  ) {
    super(`Spaces operator assignment ${reason}`);
  }
}

const tokenPattern = /^pirate-spaces-operator-v1\.(sopscred_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/u;
const verifierEqual = (presented: string, stored: unknown): boolean => {
  const valid = typeof stored === "string" && /^[0-9a-f]{64}$/u.test(stored);
  return (
    timingSafeEqual(
      Buffer.from(presented, "hex"),
      Buffer.from(valid ? stored : "0".repeat(64), "hex"),
    ) && valid
  );
};

export type SpacesOperatorServiceCapability =
  | "assignment_prepare"
  | "capability_report"
  | "funding_report";
export type SpacesOperatorServiceScope = Readonly<{
  credentialId: string;
  operatorInstanceId: string;
  environment: "development" | "staging" | "production";
  canonicalRoot: string;
  capability: SpacesOperatorServiceCapability;
}>;

const reportBase = {
  idempotency_key: Schema.String,
  operator_assignment_id: Schema.String,
  operator_assignment_generation: Schema.Int,
  network: Schema.Literal("mainnet"),
  canonical_root: Schema.String,
  operator_wallet_reference: Schema.String,
  delegation_address: Schema.String,
  observed_at: Schema.String,
};
export const SpacesOperatorCapabilityReportV1 = Schema.Struct({
  ...reportBase,
  can_operate: Schema.Boolean,
});
export const SpacesOperatorFundingReportV1 = Schema.Struct({
  ...reportBase,
  confirmed_balance_sats: Schema.String,
  next_commit_fee_sats: Schema.String,
});
type ReportCapability = "capability_report" | "funding_report";
const sats = /^(?:0|[1-9][0-9]{0,19})$/u;

const reportResponse = (row: Row, replayed: boolean) => ({
  report_id: str(row.report_id),
  operator_assignment_id: str(row.operator_assignment_id),
  operator_assignment_generation: int(row.operator_assignment_generation),
  observation_generation: int(row.observation_generation),
  status: str(row.status),
  replayed,
});

/** A separate token class: registry poll/ack tokens never authenticate here. */
export async function mintSpacesOperatorServiceCredential(
  db: ControlPlaneDb["Service"],
  input: Readonly<{
    operatorInstanceId: string;
    environment: SpacesOperatorServiceScope["environment"];
    canonicalRoot: string;
    capability: SpacesOperatorServiceCapability;
    authorizationReference: string;
  }>,
): Promise<Readonly<{ credentialId: string; token: string }>> {
  if (!isCanonicalSpacesRootV1(input.canonicalRoot))
    throw new SpacesOperatorAssignmentRefused("invalid");
  const credentialId = newId("sopscred");
  const token = `pirate-spaces-operator-v1.${credentialId}.${Buffer.from(randomBytes(32)).toString("base64url")}`;
  await transact(db, async (tx) => {
    const instance = await query(
      tx,
      "spaces-operator.credential.instance",
      `
      SELECT operator_instance_id FROM spaces_operator_instances
      WHERE operator_instance_id=$1 AND network='mainnet' AND status='active' FOR SHARE`,
      [input.operatorInstanceId],
    );
    if (instance.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("unavailable");
    await query(
      tx,
      "spaces-operator.credential.mint",
      `
      INSERT INTO spaces_operator_service_credentials
        (credential_id,operator_instance_id,environment,network,canonical_root,capability,
         verifier_sha256_hex,status,authorization_reference)
      VALUES ($1,$2,$3,'mainnet',$4,$5,$6,'active',$7)`,
      [
        credentialId,
        input.operatorInstanceId,
        input.environment,
        input.canonicalRoot,
        input.capability,
        hash(token),
        input.authorizationReference,
      ],
    );
  });
  return { credentialId, token };
}

const authenticate = async (
  tx: Tx,
  token: string,
  environment: SpacesOperatorServiceScope["environment"],
  capability: SpacesOperatorServiceCapability,
): Promise<SpacesOperatorServiceScope> => {
  const credentialId = tokenPattern.exec(token)?.[1];
  if (credentialId === undefined) throw new SpacesOperatorAssignmentRefused("unauthorized");
  const result = await query(
    tx,
    "spaces-operator.credential.authenticate",
    `
    SELECT credential.credential_id,credential.operator_instance_id,credential.environment,
           credential.canonical_root,credential.capability,credential.verifier_sha256_hex
    FROM spaces_operator_service_credentials AS credential
    JOIN spaces_operator_instances AS instance
      ON instance.operator_instance_id=credential.operator_instance_id
     AND instance.network='mainnet' AND instance.status='active'
    WHERE credential.credential_id=$1 AND credential.status='active'
      AND credential.environment=$2 AND credential.capability=$3
    FOR SHARE OF credential,instance`,
    [credentialId, environment, capability],
  );
  const row = result.rows[0];
  if (row === undefined || !verifierEqual(hash(token), row.verifier_sha256_hex)) {
    throw new SpacesOperatorAssignmentRefused("unauthorized");
  }
  return {
    credentialId: str(row.credential_id),
    operatorInstanceId: str(row.operator_instance_id),
    environment,
    canonicalRoot: str(row.canonical_root),
    capability,
  };
};

const checkSalesOwner = async (tx: Tx, accountId: string, communityId: string) => {
  const result = await query(
    tx,
    "spaces-operator.owner-authority",
    `
    SELECT authority_grant.grant_id FROM community_handle_sales_authority_grants AS authority_grant
    JOIN communities AS community ON community.community_id=authority_grant.community_id
    WHERE authority_grant.community_id=$1 AND authority_grant.principal_account_id=$2
      AND authority_grant.authority='manage_handle_sales' AND authority_grant.status='active'
      AND community.status='active' FOR SHARE OF authority_grant,community`,
    [communityId, accountId],
  );
  if (result.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("forbidden");
};

const checkMainnet = async (tx: Tx) => {
  const result = await query(
    tx,
    "spaces-operator.network",
    `
    SELECT network FROM spaces_network_configuration
    WHERE configuration_key='spaces_network_v1' FOR SHARE`,
    [],
  );
  if (result.rows.length !== 1 || result.rows[0]?.network !== "mainnet") {
    throw new SpacesOperatorAssignmentRefused("unavailable");
  }
};

const assignment = (row: Row, replayed: boolean) => ({
  operator_assignment_id: str(row.operator_assignment_id),
  generation: int(row.operator_assignment_generation),
  network: "mainnet" as const,
  canonical_root: str(row.canonical_root),
  delegation_address: str(row.delegation_address),
  replayed,
});

export type SpacesOperatorAssignmentStore = Readonly<{
  prepare: (token: string, body: unknown) => Promise<ReturnType<typeof assignment>>;
  readback: (
    token: string,
    assignmentId: string,
    generation: number,
  ) => Promise<ReturnType<typeof assignment>>;
  list: (
    input: Readonly<{ accountId: string; communityId: string; canonicalRoot: string }>,
  ) => Promise<{ candidate: ReturnType<typeof assignment> | null }>;
  confirm: (
    input: Readonly<{
      accountId: string;
      communityId: string;
      idempotencyKey: string;
      assignmentId: string;
      expectedGeneration: number;
      authorityReference: string;
      expectedAuthorityGeneration: number;
    }>,
  ) => Promise<ReturnType<typeof assignment>>;
  reportCapability: (token: string, body: unknown) => Promise<ReturnType<typeof reportResponse>>;
  reportFunding: (token: string, body: unknown) => Promise<ReturnType<typeof reportResponse>>;
  readbackReport: (
    token: string,
    capability: ReportCapability,
    reportId: string,
  ) => Promise<ReturnType<typeof reportResponse>>;
}>;

export function makeSpacesOperatorAssignmentStore(
  options: Readonly<{
    db: ControlPlaneDb["Service"];
    observer: SpacesRootAuthorityObserver;
    environment: SpacesOperatorServiceScope["environment"];
  }>,
): SpacesOperatorAssignmentStore {
  const { db, observer, environment } = options;
  const report = async (token: string, capability: ReportCapability, untrustedBody: unknown) =>
    transact(db, async (tx) => {
      const scope = await authenticate(tx, token, environment, capability);
      let body:
        | Schema.Schema.Type<typeof SpacesOperatorCapabilityReportV1>
        | Schema.Schema.Type<typeof SpacesOperatorFundingReportV1>;
      try {
        body =
          capability === "capability_report"
            ? Schema.decodeUnknownSync(SpacesOperatorCapabilityReportV1, {
                onExcessProperty: "error",
              })(untrustedBody)
            : Schema.decodeUnknownSync(SpacesOperatorFundingReportV1, {
                onExcessProperty: "error",
              })(untrustedBody);
      } catch {
        throw new SpacesOperatorAssignmentRefused("invalid");
      }
      if (
        !/^sassign_[0-9a-f]{32}$/u.test(body.operator_assignment_id) ||
        !Number.isSafeInteger(body.operator_assignment_generation) ||
        body.operator_assignment_generation < 1 ||
        !isCanonicalSpacesRootV1(body.canonical_root) ||
        !/^[!-~]{1,128}$/u.test(body.idempotency_key) ||
        !/^[!-~]{1,256}$/u.test(body.operator_wallet_reference) ||
        body.canonical_root !== scope.canonicalRoot ||
        body.network !== "mainnet" ||
        spacesDelegationScriptV1(body.delegation_address).length !== 68
      ) {
        throw new SpacesOperatorAssignmentRefused("invalid");
      }
      const request = bytes(body);
      const prior = await query(
        tx,
        "spaces-operator.report.replay",
        `
        SELECT * FROM spaces_operator_service_reports
        WHERE credential_id=$1 AND idempotency_key=$2 FOR SHARE`,
        [scope.credentialId, body.idempotency_key],
      );
      if (prior.rows.length !== 0) {
        const row = one(prior.rows);
        if (
          row.capability !== capability ||
          row.request_sha256_hex !== hash(request) ||
          !Buffer.from(row.request_bytes as Uint8Array).equals(request)
        ) {
          throw new SpacesOperatorAssignmentRefused("conflict");
        }
        return reportResponse(row, true);
      }
      const assigned = await query(
        tx,
        "spaces-operator.report.assignment",
        `
        SELECT revision.operator_assignment_id FROM spaces_operator_assignment_current AS current
        JOIN spaces_operator_assignment_revisions AS revision
          ON revision.operator_assignment_id=current.operator_assignment_id
         AND revision.operator_assignment_generation=current.current_generation
        WHERE current.operator_assignment_id=$1 AND current.current_generation=$2
          AND current.status='active' AND current.network='mainnet'
          AND current.canonical_root=$3 AND current.operator_wallet_reference=$4
          AND current.delegation_address=$5 AND revision.operator_instance_id=$6
        FOR UPDATE OF revision`,
        [
          body.operator_assignment_id,
          body.operator_assignment_generation,
          body.canonical_root,
          body.operator_wallet_reference,
          body.delegation_address,
          scope.operatorInstanceId,
        ],
      );
      if (assigned.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("forbidden");
      const now = instant(
        one(
          (await query(tx, "spaces-operator.report.clock", "SELECT clock_timestamp() AS now", []))
            .rows,
        ).now,
      );
      const observed = instant(body.observed_at);
      if (
        observed.toISOString() !== body.observed_at ||
        observed > now ||
        now.getTime() - observed.getTime() > 60_000
      ) {
        throw new SpacesOperatorAssignmentRefused("invalid");
      }
      const table =
        capability === "capability_report"
          ? "spaces_operator_capability_observations"
          : "spaces_operator_funding_observations";
      const latest = await query(
        tx,
        "spaces-operator.report.latest",
        `
        SELECT observation_generation,observed_at FROM ${table}
        WHERE operator_assignment_id=$1 AND operator_assignment_generation=$2
        ORDER BY observation_generation DESC LIMIT 1`,
        [body.operator_assignment_id, body.operator_assignment_generation],
      );
      const previous = latest.rows[0];
      if (previous !== undefined && instant(previous.observed_at) > observed) {
        throw new SpacesOperatorAssignmentRefused("conflict");
      }
      const generation = previous === undefined ? 1 : int(previous.observation_generation) + 1;
      let status: string;
      if (capability === "capability_report") {
        if (!("can_operate" in body)) throw new SpacesOperatorAssignmentRefused("invalid");
        status = body.can_operate ? "observed" : "absent";
        await query(
          tx,
          "spaces-operator.report.capability.insert",
          `
          INSERT INTO spaces_operator_capability_observations
            (operator_assignment_id,operator_assignment_generation,observation_generation,
             observed_at,fresh_until,capability_state)
          VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz+interval '5 minutes',$5)`,
          [
            body.operator_assignment_id,
            body.operator_assignment_generation,
            generation,
            body.observed_at,
            status,
          ],
        );
      } else {
        if (
          !("confirmed_balance_sats" in body) ||
          !("next_commit_fee_sats" in body) ||
          !sats.test(body.confirmed_balance_sats) ||
          !sats.test(body.next_commit_fee_sats)
        ) {
          throw new SpacesOperatorAssignmentRefused("invalid");
        }
        status =
          BigInt(body.confirmed_balance_sats) >= BigInt(body.next_commit_fee_sats)
            ? "funded_v1"
            : "commits_paused_insufficient_funds_v1";
        await query(
          tx,
          "spaces-operator.report.funding.insert",
          `
          INSERT INTO spaces_operator_funding_observations
            (operator_assignment_id,operator_assignment_generation,observation_generation,
             observed_at,confirmed_balance_sats,next_commit_fee_sats,funding_status)
          VALUES ($1,$2,$3,$4::timestamptz,$5::numeric,$6::numeric,$7)`,
          [
            body.operator_assignment_id,
            body.operator_assignment_generation,
            generation,
            body.observed_at,
            body.confirmed_balance_sats,
            body.next_commit_fee_sats,
            status,
          ],
        );
      }
      const inserted = await query(
        tx,
        "spaces-operator.report.receipt.insert",
        `
        INSERT INTO spaces_operator_service_reports
          (report_id,credential_id,capability,operator_assignment_id,
           operator_assignment_generation,idempotency_key,request_bytes,request_sha256_hex,
           observation_generation,status,observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz) RETURNING *`,
        [
          newId("sopsreport"),
          scope.credentialId,
          capability,
          body.operator_assignment_id,
          body.operator_assignment_generation,
          body.idempotency_key,
          request,
          hash(request),
          generation,
          status,
          body.observed_at,
        ],
      );
      return reportResponse(one(inserted.rows), false);
    });
  return {
    reportCapability: (token, body) => report(token, "capability_report", body),
    reportFunding: (token, body) => report(token, "funding_report", body),
    readbackReport: (token, capability, reportId) =>
      transact(db, async (tx) => {
        const scope = await authenticate(tx, token, environment, capability);
        const result = await query(
          tx,
          "spaces-operator.report.readback",
          `
        SELECT report.* FROM spaces_operator_service_reports AS report
        JOIN spaces_operator_assignment_revisions AS assignment
          ON assignment.operator_assignment_id=report.operator_assignment_id
         AND assignment.operator_assignment_generation=report.operator_assignment_generation
        WHERE report.report_id=$1 AND report.credential_id=$2 AND report.capability=$3
          AND assignment.canonical_root=$4 AND assignment.operator_instance_id=$5`,
          [reportId, scope.credentialId, capability, scope.canonicalRoot, scope.operatorInstanceId],
        );
        if (result.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("not_found");
        return reportResponse(one(result.rows), true);
      }),
    prepare: async (token, untrustedBody) =>
      transact(db, async (tx) => {
        let body: Schema.Schema.Type<typeof SpacesOperatorPrepareRequestV1>;
        try {
          body = Schema.decodeUnknownSync(SpacesOperatorPrepareRequestV1, {
            onExcessProperty: "error",
          })(untrustedBody);
        } catch {
          throw new SpacesOperatorAssignmentRefused("invalid");
        }
        const scope = await authenticate(tx, token, environment, "assignment_prepare");
        spacesDelegationScriptV1(body.delegation_address);
        if (
          scope.operatorInstanceId !== body.operator_instance_id ||
          scope.canonicalRoot !== body.canonical_root
        ) {
          throw new SpacesOperatorAssignmentRefused("forbidden");
        }
        await checkMainnet(tx);
        await query(
          tx,
          "spaces-operator.assignment.lock",
          "SELECT pg_advisory_xact_lock(hashtextextended('spaces-operator-assignment',20202))",
          [],
        );
        const request = bytes(body);
        const prior = await query(
          tx,
          "spaces-operator.assignment.prepare.replay",
          `
        SELECT * FROM spaces_operator_prepared_assignments
        WHERE credential_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [scope.credentialId, body.idempotency_key],
        );
        if (prior.rows.length !== 0) {
          const row = one(prior.rows);
          if (
            !Buffer.from(row.request_bytes as Uint8Array).equals(request) ||
            row.request_sha256_hex !== hash(request)
          ) {
            throw new SpacesOperatorAssignmentRefused("conflict");
          }
          return assignment(row, true);
        }
        const pendingRoot = await query(
          tx,
          "spaces-operator.assignment.root-unique",
          `SELECT 1 FROM spaces_operator_prepared_assignments
           WHERE environment=$1 AND network='mainnet' AND canonical_root=$2
             AND status='prepared' LIMIT 1`,
          [environment, body.canonical_root],
        );
        if (pendingRoot.rows.length !== 0) throw new SpacesOperatorAssignmentRefused("conflict");
        const taken = await query(
          tx,
          "spaces-operator.assignment.wallet-unique",
          `
        SELECT 1 FROM spaces_operator_prepared_assignments
        WHERE operator_wallet_reference=$1 OR delegation_address=$2
        UNION ALL SELECT 1 FROM spaces_operator_assignment_revisions
        WHERE operator_wallet_reference=$1 OR delegation_address=$2 LIMIT 1`,
          [body.operator_wallet_reference, body.delegation_address],
        );
        if (taken.rows.length !== 0) throw new SpacesOperatorAssignmentRefused("conflict");
        const inserted = await query(
          tx,
          "spaces-operator.assignment.prepare",
          `
        INSERT INTO spaces_operator_prepared_assignments
          (operator_assignment_id,credential_id,environment,network,canonical_root,
           operator_instance_id,operator_wallet_reference,delegation_address,idempotency_key,
           request_bytes,request_sha256_hex,status)
        VALUES ($1,$2,$3,'mainnet',$4,$5,$6,$7,$8,$9,$10,'prepared') RETURNING *`,
          [
            newId("sassign"),
            scope.credentialId,
            environment,
            body.canonical_root,
            scope.operatorInstanceId,
            body.operator_wallet_reference,
            body.delegation_address,
            body.idempotency_key,
            request,
            hash(request),
          ],
        );
        return assignment(one(inserted.rows), false);
      }),
    readback: async (token, assignmentId, generation) =>
      transact(db, async (tx) => {
        const scope = await authenticate(tx, token, environment, "assignment_prepare");
        const result = await query(
          tx,
          "spaces-operator.assignment.readback",
          `
        SELECT * FROM spaces_operator_prepared_assignments WHERE operator_assignment_id=$1
          AND operator_assignment_generation=$2 AND credential_id=$3 AND environment=$4
          AND canonical_root=$5 AND operator_instance_id=$6`,
          [
            assignmentId,
            generation,
            scope.credentialId,
            environment,
            scope.canonicalRoot,
            scope.operatorInstanceId,
          ],
        );
        if (result.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("not_found");
        return assignment(one(result.rows), true);
      }),
    list: async (input) =>
      transact(db, async (tx) => {
        if (!isCanonicalSpacesRootV1(input.canonicalRoot))
          throw new SpacesOperatorAssignmentRefused("invalid");
        await checkMainnet(tx);
        await checkSalesOwner(tx, input.accountId, input.communityId);
        const authority = await query(
          tx,
          "spaces-operator.assignment.owner-root",
          `
        SELECT 1 FROM spaces_namespace_authority_evidence
        WHERE network='mainnet' AND canonical_root=$1 AND community_id=$2
          AND controlling_account_id=$3 AND challenge_environment=$4 LIMIT 1`,
          [input.canonicalRoot, input.communityId, input.accountId, environment],
        );
        if (authority.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("forbidden");
        const candidates = await query(
          tx,
          "spaces-operator.assignment.list",
          `
        SELECT * FROM spaces_operator_prepared_assignments
        WHERE environment=$1 AND network='mainnet' AND canonical_root=$2
        ORDER BY created_at DESC,operator_assignment_id DESC LIMIT 1`,
          [environment, input.canonicalRoot],
        );
        return {
          candidate:
            candidates.rows[0] === undefined ? null : assignment(candidates.rows[0], false),
        };
      }),
    confirm: async (input) =>
      transact(db, async (tx) => {
        await checkMainnet(tx);
        await checkSalesOwner(tx, input.accountId, input.communityId);
        await query(
          tx,
          "spaces-operator.assignment.lock",
          "SELECT pg_advisory_xact_lock(hashtextextended('spaces-operator-assignment',20202))",
          [],
        );
        const result = await query(
          tx,
          "spaces-operator.assignment.confirm.read",
          `
        SELECT * FROM spaces_operator_prepared_assignments WHERE operator_assignment_id=$1 FOR UPDATE`,
          [input.assignmentId],
        );
        if (result.rows.length !== 1) throw new SpacesOperatorAssignmentRefused("not_found");
        const candidate = one(result.rows);
        if (
          candidate.environment !== environment ||
          candidate.network !== "mainnet" ||
          int(candidate.operator_assignment_generation) !== input.expectedGeneration
        ) {
          throw new SpacesOperatorAssignmentRefused("conflict");
        }
        const request = bytes({
          idempotency_key: input.idempotencyKey,
          operator_assignment_id: input.assignmentId,
          expected_generation: input.expectedGeneration,
          namespace_authority_reference: input.authorityReference,
          expected_authority_generation: input.expectedAuthorityGeneration,
        });
        if (candidate.status === "confirmed") {
          if (
            candidate.confirmed_by_account_id !== input.accountId ||
            candidate.confirm_idempotency_key !== input.idempotencyKey ||
            !Buffer.from(candidate.confirm_request_bytes as Uint8Array).equals(request)
          ) {
            throw new SpacesOperatorAssignmentRefused("conflict");
          }
          return assignment(candidate, true);
        }
        if (candidate.status !== "prepared") throw new SpacesOperatorAssignmentRefused("conflict");
        const now = one(
          (
            await query(
              tx,
              "spaces-operator.assignment.clock",
              "SELECT clock_timestamp() AS now",
              [],
            )
          ).rows,
        ).now;
        const latest = await query(
          tx,
          "spaces-operator.assignment.authority",
          `
        SELECT * FROM spaces_namespace_authority_evidence
        WHERE network='mainnet' AND canonical_root=$1
        ORDER BY namespace_authority_generation DESC LIMIT 1 FOR SHARE`,
          [candidate.canonical_root],
        );
        const authority = latest.rows[0];
        if (
          authority === undefined ||
          authority.namespace_authority_reference !== input.authorityReference ||
          int(authority.namespace_authority_generation) !== input.expectedAuthorityGeneration ||
          authority.controlling_account_id !== input.accountId ||
          authority.community_id !== input.communityId ||
          authority.challenge_environment !== environment ||
          instant(authority.fresh_until) <= instant(now)
        ) {
          throw new SpacesOperatorAssignmentRefused("conflict");
        }
        const observed = await observer
          .observe({ canonicalRoot: str(candidate.canonical_root) })
          .catch(() => {
            throw new SpacesOperatorAssignmentRefused("unavailable");
          });
        if (
          observed.kind !== "verified" ||
          observed.evidence.root !== `@${candidate.canonical_root}` ||
          observed.evidence.network !== "mainnet" ||
          !observed.evidence.anchor_bound_outpoint ||
          observed.evidence.outpoint !== authority.root_outpoint ||
          observed.evidence.owner_xonly_key_hex !== authority.root_key_hex
        ) {
          throw new SpacesOperatorAssignmentRefused("unavailable");
        }
        const existing = await query(
          tx,
          "spaces-operator.assignment.current",
          `
        SELECT 1 FROM spaces_operator_assignment_current WHERE network='mainnet'
          AND canonical_root=$1 AND status='active' LIMIT 1`,
          [candidate.canonical_root],
        );
        if (existing.rows.length !== 0) throw new SpacesOperatorAssignmentRefused("conflict");
        await query(
          tx,
          "spaces-operator.assignment.revision",
          `
        INSERT INTO spaces_operator_assignment_revisions
          (operator_assignment_id,operator_assignment_generation,network,canonical_root,
           operator_instance_id,operator_wallet_reference,delegation_address,status,created_at)
        VALUES ($1,$2,'mainnet',$3,$4,$5,$6,'active',$7)`,
          [
            input.assignmentId,
            input.expectedGeneration,
            candidate.canonical_root,
            candidate.operator_instance_id,
            candidate.operator_wallet_reference,
            candidate.delegation_address,
            candidate.created_at,
          ],
        );
        await query(
          tx,
          "spaces-operator.assignment.current.insert",
          `
        INSERT INTO spaces_operator_assignment_current
          (operator_assignment_id,network,canonical_root,operator_wallet_reference,
           delegation_address,current_generation,status,updated_at)
        VALUES ($1,'mainnet',$2,$3,$4,$5,'active',$6)`,
          [
            input.assignmentId,
            candidate.canonical_root,
            candidate.operator_wallet_reference,
            candidate.delegation_address,
            input.expectedGeneration,
            now,
          ],
        );
        const confirmed = await query(
          tx,
          "spaces-operator.assignment.confirm",
          `
        UPDATE spaces_operator_prepared_assignments SET status='confirmed',confirmed_at=$2,
          confirmed_by_account_id=$3,namespace_authority_reference=$4,
          namespace_authority_generation=$5,confirm_idempotency_key=$6,confirm_request_bytes=$7
        WHERE operator_assignment_id=$1 RETURNING *`,
          [
            input.assignmentId,
            now,
            input.accountId,
            input.authorityReference,
            input.expectedAuthorityGeneration,
            input.idempotencyKey,
            request,
          ],
        );
        return assignment(one(confirmed.rows), false);
      }),
  };
}
