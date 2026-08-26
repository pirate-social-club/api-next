import { createHash } from "node:crypto";
import {
  ControlPlaneDb,
  type ControlPlaneError,
  type ControlPlaneTransaction,
  HandleDirectGrantRecipientUnavailable,
  HandleSalesPageRejected,
  HandleSalesRejected,
  HandleSalesStorageFailed,
  type HandleSalesStore,
} from "@pirate/application";
import type {
  CommunityHandleOfferingV2,
  HandleClaimV2,
  HandleGrantPrivateV2,
  HandleQualificationPolicyRefV1,
  HandleQuoteV2,
  HandleReservationV2,
  PublicHandleGrantV3,
  PublicPersonaProfileV1,
  SaleNamespaceActivationV1,
} from "@pirate/contracts";
import {
  assertCanonicalHnsHandleLabelV2,
  assertHandleOfferingCombinationV2,
  classifyEffectiveHandleOfferingV2,
  handleAccountAllowlistPolicyHash,
  handleAccountAllowlistPolicyRequestV2Hash,
  handleClaimRequestHash,
  handleDirectGrantRecipientTokenRequestHash,
  handleFreePricingRevisionHash,
  handleGrantFinalizeV2Hash,
  handleOfferingRevisionV2Hash,
  handlePersonaLinkConfirmationRequestHash,
  handlePersonaPublicIdentityHash,
  handleQuoteRequestHash,
  handleQuoteV2Hash,
  handleReservationRequestHash,
  handleReservationV2Hash,
  handleSaleNamespaceActivationHash,
  resolvedHandleAccountCap,
  transitionHandleSaleActivationV1,
} from "@pirate/domain";
import { Effect, type Layer } from "effect";
import { publicPersonaFromSql } from "./public-persona-projection.ts";

type Row = Readonly<Record<string, unknown>>;

const storage = (reason: HandleSalesStorageFailed["reason"]): HandleSalesStorageFailed =>
  new HandleSalesStorageFailed({ reason });

const reject = (
  reason: HandleSalesRejected["reason"],
  retryable = false,
  effectiveOfferingId?: string,
): HandleSalesRejected =>
  new HandleSalesRejected({
    reason,
    retryable,
    ...(effectiveOfferingId === undefined ? {} : { effectiveOfferingId }),
  });

const mapControlPlaneError = (error: ControlPlaneError): HandleSalesStorageFailed => {
  if (error._tag === "ControlPlaneTransactionOutcomeUnknown") return storage("outcome-unknown");
  if (error._tag === "ControlPlaneOperationTimedOut" && error.outcomeCertainty === "unknown") {
    return storage("outcome-unknown");
  }
  if (error._tag === "ControlPlaneStatementFailed" && error.sqlState !== null) {
    return storage("constraint");
  }
  return storage("unavailable");
};

const mapped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, ControlPlaneError> | HandleSalesStorageFailed, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" && error !== null && "_tag" in error
        ? error._tag === "ControlPlaneAcquireFailed" ||
          error._tag === "ControlPlaneOperationTimedOut" ||
          error._tag === "ControlPlaneStatementFailed" ||
          error._tag === "ControlPlaneTransactionOutcomeUnknown"
          ? mapControlPlaneError(error as unknown as ControlPlaneError)
          : (error as Exclude<E, ControlPlaneError>)
        : (error as Exclude<E, ControlPlaneError>),
    ),
  );

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${key}`);
  return value;
};

const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
};

const integer = (row: Row, key: string): number => {
  const parsed = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${key}`);
  return parsed as number;
};

const nullableInteger = (row: Row, key: string): number | null =>
  row[key] === null ? null : integer(row, key);

const boolean = (row: Row, key: string): boolean => {
  if (typeof row[key] !== "boolean") throw new Error(`invalid ${key}`);
  return row[key] as boolean;
};

const instant = (value: unknown): string => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid instant");
  return parsed.toISOString();
};

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  throw new Error("invalid ciphertext");
};

const stringArray = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("invalid string array");
  }
  return value;
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const requestHash = (domain: string, value: unknown): string => sha256([domain, value]);

type HandlePageOperation = "activations" | "offerings" | "persona_grants";
type HandlePageCursor = Readonly<{
  snapshotCutoff: string;
  sortTime: string;
  sortId: string;
}>;

const pageRejected = (reason: HandleSalesPageRejected["reason"]): HandleSalesPageRejected =>
  new HandleSalesPageRejected({ reason });

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const base64UrlDecode = (value: string): string => {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const pageScope = (operation: HandlePageOperation, scope: string): string =>
  createHash("sha256")
    .update(JSON.stringify([operation, scope]))
    .digest("hex")
    .slice(0, 32);

const encodePageCursor = (
  operation: HandlePageOperation,
  scope: string,
  cursor: HandlePageCursor,
): string => {
  const encoded = `hcp1.${base64UrlEncode(
    JSON.stringify([
      operation,
      pageScope(operation, scope),
      Date.parse(cursor.snapshotCutoff),
      Date.parse(cursor.sortTime),
      cursor.sortId,
    ]),
  )}`;
  if (encoded.length > 256) throw pageRejected("invalid_cursor");
  return encoded;
};

const decodePageCursor = (
  value: string | undefined,
  operation: HandlePageOperation,
  scope: string,
): HandlePageCursor | null => {
  if (value === undefined) return null;
  if (!value.startsWith("hcp1.")) throw pageRejected("invalid_cursor");
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(value.slice(5)));
    if (!Array.isArray(parsed) || parsed.length !== 5) throw pageRejected("invalid_cursor");
    const [storedOperation, storedScope, snapshotMillis, sortMillis, sortId] = parsed;
    if (
      storedOperation !== operation ||
      storedScope !== pageScope(operation, scope) ||
      typeof snapshotMillis !== "number" ||
      !Number.isSafeInteger(snapshotMillis) ||
      snapshotMillis <= 0 ||
      typeof sortMillis !== "number" ||
      !Number.isSafeInteger(sortMillis) ||
      sortMillis <= 0 ||
      sortMillis > snapshotMillis ||
      typeof sortId !== "string" ||
      sortId.length === 0 ||
      sortId.length > 128 ||
      sortId !== sortId.trim() ||
      [...sortId].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw pageRejected("invalid_cursor");
    }
    return {
      snapshotCutoff: new Date(snapshotMillis).toISOString(),
      sortTime: new Date(sortMillis).toISOString(),
      sortId,
    };
  } catch (error) {
    if (error instanceof HandleSalesPageRejected) throw error;
    throw pageRejected("invalid_cursor");
  }
};

const pageLimit = (value: number | undefined): number => {
  const resolved = value ?? 20;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw pageRejected("invalid_limit");
  }
  return resolved;
};

const advisoryLock = (
  transaction: ControlPlaneTransaction,
  namespace: number,
  parts: readonly string[],
  label: string,
) =>
  transaction.execute({
    label,
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
    values: [JSON.stringify(parts), namespace],
    readonly: false,
  });

const one = (rows: readonly Row[], label: string): Row => {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`invalid ${label} cardinality`);
  return rows[0];
};

const activationFromRow = (row: Row): SaleNamespaceActivationV1 => ({
  sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
  sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
  sale_namespace_activation_hash: text(row, "sale_namespace_activation_hash"),
  community_id: text(row, "community_id"),
  family: "hns",
  canonical_root: text(row, "canonical_root"),
  display_root: text(row, "display_root"),
  namespace_authority: {
    kind: "verified_namespace_v1",
    namespace_authority_reference: text(row, "namespace_authority_reference"),
    namespace_authority_generation: integer(row, "namespace_authority_generation"),
  },
  serving: {
    kind: "hns_dns_zone_activation_v1",
    dns_zone_activation_id: text(row, "dns_zone_activation_id"),
    dns_zone_activation_generation: integer(row, "dns_zone_activation_generation"),
  },
  root_replacement: { kind: "dedicated_root_replace_v1", confirmed: true },
  status: text(row, "status") as SaleNamespaceActivationV1["status"],
  created_at: instant(row.created_at),
  activated_at: row.activated_at === null ? null : instant(row.activated_at),
  suspended_at: row.suspended_at === null ? null : instant(row.suspended_at),
  revoked_at: row.revoked_at === null ? null : instant(row.revoked_at),
});

const publicGrantFromRow = (row: Row): PublicHandleGrantV3 => {
  const persona = publicPersonaFromSql(row.owner_persona);
  if (persona === undefined || persona === null) throw new Error("invalid public persona");
  const grantGeneration = integer(row, "grant_generation");
  const activationGeneration = integer(row, "sale_namespace_activation_generation");
  const namespaceRoot = text(row, "namespace_root");
  const handleLabel = text(row, "handle_label");
  const activationEffective = boolean(row, "activation_effective");
  return {
    grant_id: text(row, "grant_id"),
    grant_generation: grantGeneration,
    community_id: text(row, "community_id"),
    owner_persona: persona,
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: activationGeneration,
    fulfillment: {
      kind: text(row, "fulfillment_kind") as PublicHandleGrantV3["fulfillment"]["kind"],
    },
    handle: {
      family: text(row, "family") as PublicHandleGrantV3["handle"]["family"],
      namespace_root: namespaceRoot,
      handle_label: handleLabel,
    },
    display_identifier: text(row, "display_identifier"),
    host: activationEffective
      ? {
          kind: "available",
          normalized_host: `${handleLabel}.${namespaceRoot}`,
          sale_namespace_activation_generation: activationGeneration,
          grant_generation: grantGeneration,
        }
      : { kind: "unavailable", reason: "sale_namespace_inactive" },
    issued_at: instant(row.issued_at),
  };
};

const offeringFromRow = (row: Row): CommunityHandleOfferingV2 => {
  const exactLabel = nullableText(row, "exact_label");
  const labelScope =
    text(row, "label_scope_kind") === "exact_label_v2"
      ? {
          kind: "exact_label_v2" as const,
          label_grammar_id: "hns_ascii_ldh_1_63_v1" as const,
          handle_label:
            exactLabel ??
            (() => {
              throw new Error("missing exact label");
            })(),
          reserved_labels_id: text(row, "reserved_labels_id"),
          reserved_labels_revision: integer(row, "reserved_labels_revision"),
          reserved_labels_hash: text(row, "reserved_labels_hash"),
        }
      : {
          kind: "label_rule_v2" as const,
          label_grammar_id: "hns_ascii_ldh_1_63_v1" as const,
          reserved_labels_id: text(row, "reserved_labels_id"),
          reserved_labels_revision: integer(row, "reserved_labels_revision"),
          reserved_labels_hash: text(row, "reserved_labels_hash"),
          availability: {
            kind: "length_band_v1" as const,
            min_label_length: integer(row, "min_label_length"),
            max_label_length: integer(row, "max_label_length"),
          },
        };
  const policyKind = text(row, "policy_kind");
  const policy: HandleQualificationPolicyRefV1 =
    policyKind === "none_v1"
      ? {
          kind: "none_v1",
          policy_id: text(row, "qualification_policy_id"),
          policy_revision: integer(row, "qualification_policy_revision"),
          policy_hash: text(row, "qualification_policy_hash"),
        }
      : {
          kind: "curated_policy_v1",
          policy_id: text(row, "qualification_policy_id"),
          policy_revision: integer(row, "qualification_policy_revision"),
          policy_hash: text(row, "qualification_policy_hash"),
          provider_binding_hash:
            nullableText(row, "provider_binding_hash") ??
            (() => {
              throw new Error("missing provider binding hash");
            })(),
        };
  return {
    offering_id: text(row, "offering_id"),
    offering_revision: integer(row, "offering_revision"),
    offering_hash: text(row, "offering_hash"),
    community_id: text(row, "community_id"),
    family: text(row, "family") as "hns" | "spaces",
    namespace_root: text(row, "namespace_root"),
    display_root: text(row, "display_root"),
    sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
    sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
    label_scope: labelScope,
    allocation: {
      kind: text(row, "allocation_kind") as CommunityHandleOfferingV2["allocation"]["kind"],
    },
    max_active_grants_per_account: nullableInteger(row, "max_active_grants_per_account"),
    fulfillment: {
      kind: text(row, "fulfillment_kind") as CommunityHandleOfferingV2["fulfillment"]["kind"],
    },
    qualification_policy: policy,
    pricing: {
      kind: "free_v1",
      pricing_id: text(row, "pricing_id"),
      pricing_revision: integer(row, "pricing_revision"),
      pricing_hash: text(row, "pricing_hash"),
      atomic_amount: "0",
    },
    issuance: {
      family: text(row, "family") as "hns" | "spaces",
      driver_id: text(row, "issuance_driver_id"),
      driver_version: text(row, "issuance_driver_version"),
    },
    quote_ttl_seconds: integer(row, "quote_ttl_seconds"),
    reservation_ttl_seconds: integer(row, "reservation_ttl_seconds"),
    status: text(row, "status") as CommunityHandleOfferingV2["status"],
    created_at: instant(row.created_at),
  };
};

const quoteFromRow = (row: Row): HandleQuoteV2 => ({
  quote_id: text(row, "quote_id"),
  quote_hash: text(row, "quote_hash"),
  offering_id: text(row, "offering_id"),
  offering_revision: integer(row, "offering_revision"),
  offering_hash: text(row, "offering_hash"),
  sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
  sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
  fulfillment: { kind: "hosted_persona_v1" },
  owner_persona_id: text(row, "owner_persona_id"),
  handle: {
    family: "hns",
    namespace_root: text(row, "namespace_root"),
    handle_label: text(row, "handle_label"),
  },
  display_identifier: text(row, "display_identifier"),
  pricing: {
    kind: "free_v1",
    pricing_id: text(row, "pricing_id"),
    pricing_revision: integer(row, "pricing_revision"),
    pricing_hash: text(row, "pricing_hash"),
    atomic_amount: "0",
  },
  eligibility: {
    policy_revision: integer(row, "eligibility_policy_revision"),
    policy_hash: text(row, "eligibility_policy_hash"),
    decision: "passed",
    evidence_use_ids: [...stringArray(row.evidence_use_ids)],
    evaluated_at: instant(row.evaluated_at),
  },
  status: text(row, "status") as HandleQuoteV2["status"],
  quoted_at: instant(row.quoted_at),
  expires_at: instant(row.expires_at),
});

const reservationFromRow = (row: Row): HandleReservationV2 => ({
  reservation_id: text(row, "reservation_id"),
  reservation_hash: text(row, "reservation_hash"),
  quote_id: text(row, "quote_id"),
  quote_hash: text(row, "quote_hash"),
  offering_id: text(row, "offering_id"),
  offering_hash: text(row, "offering_hash"),
  sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
  sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
  fulfillment: { kind: "hosted_persona_v1" },
  owner_persona_id: text(row, "owner_persona_id"),
  handle: {
    family: "hns",
    namespace_root: text(row, "namespace_root"),
    handle_label: text(row, "handle_label"),
  },
  status: text(row, "status") as HandleReservationV2["status"],
  reserved_at: instant(row.reserved_at),
  expires_at: instant(row.expires_at),
});

const grantFromRow = (row: Row, prefix = ""): HandleGrantPrivateV2 => ({
  grant_id: text(row, `${prefix}grant_id`),
  grant_generation: integer(row, `${prefix}grant_generation`),
  community_id: text(row, `${prefix}community_id`),
  offering_id: text(row, `${prefix}offering_id`),
  offering_hash: text(row, `${prefix}offering_hash`),
  claim_id: text(row, `${prefix}claim_id`),
  owner_persona_id: text(row, `${prefix}owner_persona_id`),
  sale_namespace_activation_id: text(row, `${prefix}sale_namespace_activation_id`),
  sale_namespace_activation_generation: integer(
    row,
    `${prefix}sale_namespace_activation_generation`,
  ),
  fulfillment: { kind: "hosted_persona_v1" },
  handle: {
    family: "hns",
    namespace_root: text(row, `${prefix}namespace_root`),
    handle_label: text(row, `${prefix}handle_label`),
  },
  display_identifier: text(row, `${prefix}display_identifier`),
  status: text(row, `${prefix}status`) as HandleGrantPrivateV2["status"],
  issued_at: instant(row[`${prefix}issued_at`]),
});

const claimFromRow = (row: Row): HandleClaimV2 => ({
  claim_id: text(row, "claim_id"),
  owner_persona_id: text(row, "owner_persona_id"),
  offering_id: text(row, "offering_id"),
  offering_hash: text(row, "offering_hash"),
  quote_id: text(row, "quote_id"),
  reservation_id: text(row, "reservation_id"),
  reservation_hash: text(row, "reservation_hash"),
  sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
  sale_namespace_activation_generation: integer(row, "sale_namespace_activation_generation"),
  fulfillment: { kind: "hosted_persona_v1" },
  handle: {
    family: "hns",
    namespace_root: text(row, "namespace_root"),
    handle_label: text(row, "handle_label"),
  },
  display_identifier: text(row, "display_identifier"),
  payment: {
    kind: "not_required_v1",
    pricing_revision: integer(row, "pricing_revision"),
    pricing_hash: text(row, "pricing_hash"),
    atomic_amount: "0",
    status: "not_applicable",
  },
  state: text(row, "state") as HandleClaimV2["state"],
  safe_reason: nullableText(row, "safe_reason") as HandleClaimV2["safe_reason"],
  grant: row.grant_id === null ? null : grantFromRow(row, "grant_"),
  created_at: instant(row.created_at),
  updated_at: instant(row.updated_at),
});

const CLAIM_SELECT = `
  SELECT claim.*,
         handle_grant.grant_id AS grant_grant_id,
         handle_grant.grant_generation AS grant_grant_generation,
         handle_grant.community_id AS grant_community_id,
         handle_grant.offering_id AS grant_offering_id,
         handle_grant.offering_hash AS grant_offering_hash,
         handle_grant.claim_id AS grant_claim_id,
         handle_grant.owner_persona_id AS grant_owner_persona_id,
         handle_grant.sale_namespace_activation_id AS grant_sale_namespace_activation_id,
         handle_grant.sale_namespace_activation_generation AS grant_sale_namespace_activation_generation,
         handle_grant.namespace_root AS grant_namespace_root,
         handle_grant.handle_label AS grant_handle_label,
         handle_grant.display_identifier AS grant_display_identifier,
         handle_grant.status AS grant_status,
         handle_grant.issued_at AS grant_issued_at
    FROM handle_claims AS claim
    LEFT JOIN handle_grants AS handle_grant ON handle_grant.grant_id=claim.grant_id`;

const ACTIVATION_SELECT = `
  SELECT revision.*
    FROM community_handle_sale_namespace_activation_revisions AS revision`;

const OFFERING_SELECT = `
  SELECT revision.*,
         policy.policy_kind,
         policy.subject_account_id
    FROM community_handle_offering_revisions AS revision
    JOIN handle_qualification_policy_revisions AS policy
      ON policy.policy_id = revision.qualification_policy_id
     AND policy.policy_revision = revision.qualification_policy_revision`;

const readActivation = (
  transaction: ControlPlaneTransaction,
  activationId: string,
  generation: number,
) =>
  transaction.execute<Row>({
    label: "handle-sales.activation.read",
    text: `${ACTIVATION_SELECT}
            WHERE revision.sale_namespace_activation_id=$1
              AND revision.sale_namespace_activation_generation=$2`,
    values: [activationId, generation],
    readonly: false,
  });

const readOffering = (transaction: ControlPlaneTransaction, offeringId: string, revision: number) =>
  transaction.execute<Row>({
    label: "handle-sales.offering.read",
    text: `${OFFERING_SELECT}
            WHERE revision.offering_id=$1 AND revision.offering_revision=$2`,
    values: [offeringId, revision],
    readonly: false,
  });

const activeHumanEvidence = (
  transaction: ControlPlaneTransaction,
  accountId: string,
  databaseNow: string,
) =>
  transaction.execute<Row>({
    label: "handle-sales.human-evidence.read",
    text: `SELECT evidence_receipt_id
             FROM evidence_receipts
            WHERE user_id=$1
              AND evidence_kind='very.web.server-verified.v1'
              AND (expires_at IS NULL OR expires_at > $2::timestamptz)
            ORDER BY observed_at DESC, evidence_receipt_id DESC
            LIMIT 1`,
    values: [accountId, databaseNow],
    readonly: false,
  });

const currentDatabaseTime = (transaction: ControlPlaneTransaction) =>
  transaction.execute<Row>({
    label: "handle-sales.database-clock.read",
    text: "SELECT clock_timestamp() AS database_now",
    values: [],
    readonly: false,
  });

const purgeExpiredRecipientTokens = (transaction: ControlPlaneTransaction) =>
  transaction.execute({
    label: "handle-sales.recipient-token.expired.purge",
    text: `DELETE FROM handle_direct_grant_recipient_tokens AS token
            USING (
              SELECT expired.token_id
                FROM handle_direct_grant_recipient_tokens AS expired
               WHERE expired.status IN ('current','superseded')
                 AND expired.expires_at <= clock_timestamp()
               ORDER BY expired.expires_at,expired.token_id
               LIMIT 256
               FOR UPDATE SKIP LOCKED
            ) AS expired
            WHERE token.token_id=expired.token_id`,
    values: [],
    readonly: false,
  });

const mutationReplay = (
  transaction: ControlPlaneTransaction,
  table: "community_handle_sale_namespace_activation_actions" | "community_handle_offering_actions",
  accountId: string,
  endpoint: string,
  idempotencyKey: string,
) =>
  transaction.execute<Row>({
    label: "handle-sales.mutation-replay.read",
    text: `SELECT * FROM ${table}
            WHERE actor_account_id=$1 AND endpoint_template=$2 AND idempotency_key=$3
            FOR UPDATE`,
    values: [accountId, endpoint, idempotencyKey],
    readonly: false,
  });

type OfferingMutationInput = Parameters<HandleSalesStore["createOffering"]>[0] &
  Partial<{
    offeringId: string;
    expectedOfferingHash: string;
    requestedStatus: "active" | "paused" | "retired";
  }>;

const mutateOffering = (
  transaction: ControlPlaneTransaction,
  input: OfferingMutationInput,
  endpoint:
    | "/communities/:communityId/handle-offerings"
    | "/communities/:communityId/handle-offerings/:offeringId/revisions",
) =>
  Effect.gen(function* () {
    const isCreate = endpoint === "/communities/:communityId/handle-offerings";
    const hash = requestHash("pirate-handle-offering-mutation-request-v2", {
      account_id: input.accountId,
      community_id: input.communityId,
      endpoint,
      idempotency_key: input.idempotencyKey,
      ...(isCreate
        ? {}
        : {
            offering_id: input.offeringId,
            expected_offering_hash: input.expectedOfferingHash,
            requested_status: input.requestedStatus,
          }),
      terms: input.terms,
    });
    const replay = yield* mutationReplay(
      transaction,
      "community_handle_offering_actions",
      input.accountId,
      endpoint,
      input.idempotencyKey,
    );
    if (replay.rows[0] !== undefined) {
      const row = replay.rows[0];
      if (text(row, "request_hash") !== hash || text(row, "community_id") !== input.communityId) {
        return yield* reject("idempotency_conflict");
      }
      const result = yield* readOffering(
        transaction,
        text(row, "offering_id"),
        integer(row, "result_offering_revision"),
      );
      return { offering: offeringFromRow(one(result.rows, "offering replay")), replayed: true };
    }
    const authority = yield* transaction.execute<Row>({
      label: "handle-sales.offering.authority.read",
      text: `SELECT grant_id FROM community_handle_sales_authority_grants
              WHERE community_id=$1 AND principal_account_id=$2
                AND authority='manage_handle_sales' AND status='active' FOR SHARE`,
      values: [input.communityId, input.accountId],
      readonly: false,
    });
    if (authority.rows[0] === undefined) return yield* reject("offering_unavailable");
    yield* advisoryLock(
      transaction,
      53_003,
      [input.terms.sale_namespace_activation_id],
      "handle-sales.offering.activation.lock",
    );
    const activationResult = yield* transaction.execute<Row>({
      label: "handle-sales.offering.activation.read",
      text: `${ACTIVATION_SELECT}
              WHERE revision.sale_namespace_activation_id=$1
                AND revision.sale_namespace_activation_generation=$2
                AND revision.community_id=$3`,
      values: [
        input.terms.sale_namespace_activation_id,
        input.terms.expected_sale_namespace_activation_generation,
        input.communityId,
      ],
      readonly: false,
    });
    const activationRow = activationResult.rows[0];
    if (activationRow === undefined) return yield* reject("sale_namespace_inactive", true);
    const requestedStatus = isCreate ? "active" : input.requestedStatus;
    if (requestedStatus === undefined) return yield* reject("offering_unavailable");
    if (requestedStatus === "active") {
      const effective = yield* transaction.execute<Row>({
        label: "handle-sales.offering.activation-effective.read",
        text: `SELECT sale_namespace_activation_id
                 FROM effective_community_handle_sale_namespace_v1($1,clock_timestamp())`,
        values: [input.terms.sale_namespace_activation_id],
        readonly: false,
      });
      if (effective.rows[0] === undefined) return yield* reject("sale_namespace_inactive", true);
    }
    const priorCurrent = isCreate
      ? null
      : yield* transaction.execute<Row>({
          label: "handle-sales.offering.current.lock",
          text: `${OFFERING_SELECT}
                 JOIN community_handle_offering_current AS current_offering
                   ON current_offering.offering_id=revision.offering_id
                  AND current_offering.current_revision=revision.offering_revision
                WHERE revision.offering_id=$1 AND revision.community_id=$2
                FOR UPDATE OF current_offering`,
          values: [input.offeringId, input.communityId],
          readonly: false,
        });
    if (!isCreate && priorCurrent?.rows[0] === undefined)
      return yield* reject("offering_unavailable");
    const prior =
      priorCurrent?.rows[0] === undefined ? null : offeringFromRow(priorCurrent.rows[0]);
    if (
      prior !== null &&
      (prior.offering_hash !== input.expectedOfferingHash || prior.status === "retired")
    ) {
      return yield* reject("offering_unavailable", true);
    }
    const reserved = yield* transaction.execute<Row>({
      label: "handle-sales.offering.reserved-labels.read",
      text: `SELECT * FROM handle_reserved_label_revisions
              WHERE reserved_labels_id=$1 AND reserved_labels_revision=$2
                AND family='hns' AND status='active' FOR SHARE`,
      values: [
        input.terms.label_scope.reserved_labels_id,
        input.terms.label_scope.expected_reserved_labels_revision,
      ],
      readonly: false,
    });
    const policy = yield* transaction.execute<Row>({
      label: "handle-sales.offering.policy.read",
      text: `SELECT * FROM handle_qualification_policy_revisions
              WHERE policy_id=$1 AND policy_revision=$2 AND status='active'
                AND (community_id IS NULL OR community_id=$3) FOR SHARE`,
      values: [
        input.terms.qualification_policy_id,
        input.terms.expected_qualification_policy_revision,
        input.communityId,
      ],
      readonly: false,
    });
    const pricing = yield* transaction.execute<Row>({
      label: "handle-sales.offering.pricing.read",
      text: `SELECT * FROM handle_pricing_revisions
              WHERE pricing_id=$1 AND pricing_revision=$2 AND status='active' FOR SHARE`,
      values: [input.terms.pricing_id, input.terms.expected_pricing_revision],
      readonly: false,
    });
    const driver = yield* transaction.execute<Row>({
      label: "handle-sales.offering.driver.read",
      text: `SELECT * FROM handle_issuance_driver_revisions
              WHERE family='hns' AND driver_id=$1 AND driver_version=$2
                AND status='enabled' FOR SHARE`,
      values: [input.terms.issuance_driver_id, input.terms.expected_issuance_driver_version],
      readonly: false,
    });
    if (
      reserved.rows[0] === undefined ||
      policy.rows[0] === undefined ||
      pricing.rows[0] === undefined ||
      driver.rows[0] === undefined
    ) {
      return yield* reject("offering_unavailable", true);
    }
    const reservedRow = one(reserved.rows, "reserved labels");
    const policyRow = one(policy.rows, "qualification policy");
    const pricingRow = one(pricing.rows, "pricing");
    const driverRow = one(driver.rows, "issuance driver");
    const labelScope =
      input.terms.label_scope.kind === "exact_label_v2"
        ? {
            kind: "exact_label_v2" as const,
            label_grammar_id: "hns_ascii_ldh_1_63_v1" as const,
            handle_label: input.terms.label_scope.handle_label,
            reserved_labels_id: input.terms.label_scope.reserved_labels_id,
            reserved_labels_revision: input.terms.label_scope.expected_reserved_labels_revision,
            reserved_labels_hash: text(reservedRow, "reserved_labels_hash"),
          }
        : {
            kind: "label_rule_v2" as const,
            label_grammar_id: "hns_ascii_ldh_1_63_v1" as const,
            reserved_labels_id: input.terms.label_scope.reserved_labels_id,
            reserved_labels_revision: input.terms.label_scope.expected_reserved_labels_revision,
            reserved_labels_hash: text(reservedRow, "reserved_labels_hash"),
            availability: input.terms.label_scope.availability,
          };
    if (
      labelScope.kind === "exact_label_v2" &&
      [
        ...stringArray(reservedRow.platform_labels),
        ...stringArray(reservedRow.namespace_labels),
      ].includes(labelScope.handle_label)
    ) {
      return yield* reject("handle_unavailable");
    }
    const maxCap = yield* Effect.try({
      try: () =>
        resolvedHandleAccountCap({
          label_scope_kind: labelScope.kind,
          allocation_kind: input.terms.allocation_kind,
          ...(input.terms.max_active_grants_per_account === undefined
            ? {}
            : { requested_cap: input.terms.max_active_grants_per_account }),
        }),
      catch: () => reject("offering_unavailable"),
    });
    const qualificationPolicy: HandleQualificationPolicyRefV1 =
      text(policyRow, "policy_kind") === "none_v1"
        ? {
            kind: "none_v1",
            policy_id: text(policyRow, "policy_id"),
            policy_revision: integer(policyRow, "policy_revision"),
            policy_hash: text(policyRow, "policy_hash"),
          }
        : {
            kind: "curated_policy_v1",
            policy_id: text(policyRow, "policy_id"),
            policy_revision: integer(policyRow, "policy_revision"),
            policy_hash: text(policyRow, "policy_hash"),
            provider_binding_hash: text(policyRow, "provider_binding_hash"),
          };
    const freePricing = {
      kind: "free_v1" as const,
      pricing_id: text(pricingRow, "pricing_id"),
      pricing_revision: integer(pricingRow, "pricing_revision"),
      pricing_hash: text(pricingRow, "pricing_hash"),
      atomic_amount: "0" as const,
    };
    yield* Effect.try({
      try: () => {
        handleFreePricingRevisionHash(freePricing);
        assertHandleOfferingCombinationV2({
          label_scope: labelScope,
          allocation_kind: input.terms.allocation_kind,
          fulfillment_kind: input.terms.fulfillment_kind,
          qualification_kind: qualificationPolicy.kind,
          pricing_kind: freePricing.kind,
          atomic_amount: freePricing.atomic_amount,
        });
        if (
          text(driverRow, "fulfillment_kind") !== input.terms.fulfillment_kind ||
          input.terms.fulfillment_kind !== "hosted_persona_v1"
        ) {
          throw new Error("driver mismatch");
        }
      },
      catch: () => reject("paid_offerings_disabled"),
    });
    const activeReserved = yield* transaction.execute<Row>({
      label: "handle-sales.offering.reserved-consistency.read",
      text: `SELECT revision.reserved_labels_id,revision.reserved_labels_revision
               FROM community_handle_offering_current AS current_offering
               JOIN community_handle_offering_revisions AS revision
                 ON revision.offering_id=current_offering.offering_id
                AND revision.offering_revision=current_offering.current_revision
              WHERE current_offering.sale_namespace_activation_id=$1
                AND current_offering.status='active'
                AND current_offering.offering_id<>$2
              LIMIT 1`,
      values: [input.terms.sale_namespace_activation_id, input.offeringId],
      readonly: false,
    });
    if (
      activeReserved.rows[0] !== undefined &&
      (text(activeReserved.rows[0], "reserved_labels_id") !== labelScope.reserved_labels_id ||
        integer(activeReserved.rows[0], "reserved_labels_revision") !==
          labelScope.reserved_labels_revision)
    ) {
      return yield* reject("offering_unavailable");
    }
    const offeringId = input.offeringId;
    const revision = prior === null ? 1 : prior.offering_revision + 1;
    const activation = activationFromRow(activationRow);
    const offeringHash = handleOfferingRevisionV2Hash({
      offering_id: offeringId,
      offering_revision: revision,
      community_id: input.communityId,
      family: "hns",
      namespace_root: activation.canonical_root,
      sale_namespace_activation_id: activation.sale_namespace_activation_id,
      sale_namespace_activation_generation: activation.sale_namespace_activation_generation,
      label_scope: labelScope,
      allocation_kind: input.terms.allocation_kind,
      max_active_grants_per_account: maxCap,
      fulfillment_kind: input.terms.fulfillment_kind,
      qualification_policy: qualificationPolicy,
      pricing: freePricing,
      issuance_driver_id: input.terms.issuance_driver_id,
      issuance_driver_version: input.terms.expected_issuance_driver_version,
      quote_ttl_seconds: input.terms.quote_ttl_seconds,
      reservation_ttl_seconds: input.terms.reservation_ttl_seconds,
    }).sha256;
    const now = instant(
      one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
    );
    const createdAt = prior?.created_at ?? now;
    yield* transaction.execute({
      label: "handle-sales.offering.revision.insert",
      text: `INSERT INTO community_handle_offering_revisions (
               offering_id,offering_revision,offering_hash,community_id,family,namespace_root,
               display_root,sale_namespace_activation_id,sale_namespace_activation_generation,
               label_scope_kind,label_grammar_id,exact_label,min_label_length,max_label_length,
               reserved_labels_id,reserved_labels_revision,reserved_labels_hash,allocation_kind,
               max_active_grants_per_account,fulfillment_kind,qualification_policy_id,
               qualification_policy_revision,qualification_policy_hash,provider_binding_hash,
               pricing_id,pricing_revision,pricing_hash,atomic_amount,issuance_driver_id,
               issuance_driver_version,quote_ttl_seconds,reservation_ttl_seconds,status,
               actor_account_id,created_at,recorded_at
             ) VALUES (
               $1,$2,$3,$4,'hns',$5,$6,$7,$8,$9,'hns_ascii_ldh_1_63_v1',$10,$11,$12,
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,0,$26,$27,$28,$29,
               $30,$31,$32::timestamptz,$33::timestamptz
             )`,
      values: [
        offeringId,
        revision,
        offeringHash,
        input.communityId,
        activation.canonical_root,
        activation.display_root,
        activation.sale_namespace_activation_id,
        activation.sale_namespace_activation_generation,
        labelScope.kind,
        labelScope.kind === "exact_label_v2" ? labelScope.handle_label : null,
        labelScope.kind === "label_rule_v2" ? labelScope.availability.min_label_length : null,
        labelScope.kind === "label_rule_v2" ? labelScope.availability.max_label_length : null,
        labelScope.reserved_labels_id,
        labelScope.reserved_labels_revision,
        labelScope.reserved_labels_hash,
        input.terms.allocation_kind,
        maxCap,
        input.terms.fulfillment_kind,
        qualificationPolicy.policy_id,
        qualificationPolicy.policy_revision,
        qualificationPolicy.policy_hash,
        qualificationPolicy.kind === "curated_policy_v1"
          ? qualificationPolicy.provider_binding_hash
          : null,
        freePricing.pricing_id,
        freePricing.pricing_revision,
        freePricing.pricing_hash,
        input.terms.issuance_driver_id,
        input.terms.expected_issuance_driver_version,
        input.terms.quote_ttl_seconds,
        input.terms.reservation_ttl_seconds,
        requestedStatus,
        input.accountId,
        createdAt,
        now,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "handle-sales.offering.current.write",
      text: isCreate
        ? `INSERT INTO community_handle_offering_current (
             offering_id,community_id,sale_namespace_activation_id,current_revision,status,
             label_scope_kind,exact_label,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`
        : `UPDATE community_handle_offering_current
              SET sale_namespace_activation_id=$3,current_revision=$4,status=$5,
                  label_scope_kind=$6,exact_label=$7,updated_at=$8::timestamptz
            WHERE offering_id=$1 AND community_id=$2`,
      values: [
        offeringId,
        input.communityId,
        activation.sale_namespace_activation_id,
        revision,
        requestedStatus,
        labelScope.kind,
        labelScope.kind === "exact_label_v2" ? labelScope.handle_label : null,
        now,
      ],
      readonly: false,
    });
    yield* transaction.execute({
      label: "handle-sales.offering.action.insert",
      text: `INSERT INTO community_handle_offering_actions (
               action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
               request_hash,offering_id,result_offering_revision,result_offering_hash,committed_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)`,
      values: [
        input.actionId,
        input.accountId,
        input.communityId,
        endpoint,
        input.idempotencyKey,
        hash,
        offeringId,
        revision,
        offeringHash,
        now,
      ],
      readonly: false,
    });
    const result = yield* readOffering(transaction, offeringId, revision);
    return { offering: offeringFromRow(one(result.rows, "written offering")), replayed: false };
  });

export function makeControlPlaneHandleSalesRepository() {
  return {
    createSaleNamespace: (input: Parameters<HandleSalesStore["createSaleNamespace"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const hash = requestHash("pirate-handle-sale-namespace-create-request-v1", {
                account_id: input.accountId,
                community_id: input.communityId,
                idempotency_key: input.idempotencyKey,
                namespace_authority_reference: input.namespaceAuthorityReference,
                expected_namespace_authority_generation: input.expectedNamespaceAuthorityGeneration,
                dns_zone_activation_id: input.dnsZoneActivationId,
                expected_dns_zone_activation_generation: input.expectedDnsZoneActivationGeneration,
                dedicated_root_replacement_confirmed: input.dedicatedRootReplacementConfirmed,
              });
              const replay = yield* mutationReplay(
                transaction,
                "community_handle_sale_namespace_activation_actions",
                input.accountId,
                "/communities/:communityId/handle-sale-namespaces",
                input.idempotencyKey,
              );
              if (replay.rows[0] !== undefined) {
                const row = replay.rows[0];
                if (
                  text(row, "request_hash") !== hash ||
                  text(row, "community_id") !== input.communityId
                ) {
                  return yield* reject("idempotency_conflict");
                }
                const result = yield* readActivation(
                  transaction,
                  text(row, "sale_namespace_activation_id"),
                  integer(row, "result_activation_generation"),
                );
                return {
                  activation: activationFromRow(one(result.rows, "activation replay")),
                  replayed: true,
                };
              }
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              const authority = yield* transaction.execute<Row>({
                label: "handle-sales.activation.authority.read",
                text: `SELECT grant_id
                         FROM community_handle_sales_authority_grants
                        WHERE community_id=$1 AND principal_account_id=$2
                          AND authority='manage_handle_sales' AND status='active'
                        FOR SHARE`,
                values: [input.communityId, input.accountId],
                readonly: false,
              });
              if (authority.rows[0] === undefined) return yield* reject("offering_unavailable");
              const dependency = yield* transaction.execute<Row>({
                label: "handle-sales.activation.dependency.read",
                text: `SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,$6::timestamptz)`,
                values: [
                  input.communityId,
                  input.namespaceAuthorityReference,
                  input.expectedNamespaceAuthorityGeneration,
                  input.dnsZoneActivationId,
                  input.expectedDnsZoneActivationGeneration,
                  now,
                ],
                readonly: false,
              });
              const dependencyRow = dependency.rows[0];
              if (
                dependencyRow === undefined ||
                !boolean(dependencyRow, "dns_delegation_current")
              ) {
                return yield* reject("dns_delegation_required", true);
              }
              const canonicalRoot = text(dependencyRow, "canonical_root");
              if (canonicalRoot === "pirate") return yield* reject("platform_namespace_reserved");
              yield* advisoryLock(
                transaction,
                53_001,
                ["hns", canonicalRoot],
                "handle-sales.activation.root.lock",
              );
              const activationHash = handleSaleNamespaceActivationHash({
                sale_namespace_activation_id: input.activationId,
                sale_namespace_activation_generation: 1,
                community_id: input.communityId,
                family: "hns",
                canonical_root: canonicalRoot,
                namespace_authority_reference: input.namespaceAuthorityReference,
                namespace_authority_generation: input.expectedNamespaceAuthorityGeneration,
                dns_zone_activation_id: input.dnsZoneActivationId,
                dns_zone_activation_generation: input.expectedDnsZoneActivationGeneration,
              }).sha256;
              yield* transaction.execute({
                label: "handle-sales.activation.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_revisions (
                         sale_namespace_activation_id,sale_namespace_activation_generation,
                         sale_namespace_activation_hash,community_id,family,canonical_root,display_root,
                         namespace_authority_kind,namespace_authority_reference,
                         namespace_authority_generation,serving_kind,dns_zone_activation_id,
                         dns_zone_activation_generation,root_replacement_kind,
                         dedicated_root_replacement_confirmed,status,reason_code,actor_account_id,
                         authority_grant_id,created_at,activated_at,suspended_at,revoked_at,recorded_at
                       ) VALUES (
                         $1,1,$2,$3,'hns',$4,$5,'verified_namespace_v1',$6,$7,
                         'hns_dns_zone_activation_v1',$8,$9,'dedicated_root_replace_v1',TRUE,
                         'active',NULL,$10,$11,$12::timestamptz,$12::timestamptz,NULL,NULL,$12::timestamptz
                       )`,
                values: [
                  input.activationId,
                  activationHash,
                  input.communityId,
                  canonicalRoot,
                  text(dependencyRow, "display_root"),
                  input.namespaceAuthorityReference,
                  input.expectedNamespaceAuthorityGeneration,
                  input.dnsZoneActivationId,
                  input.expectedDnsZoneActivationGeneration,
                  input.accountId,
                  text(one(authority.rows, "sales authority"), "grant_id"),
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.activation.current.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_current (
                         sale_namespace_activation_id,family,canonical_root,community_id,current_generation,updated_at
                       ) VALUES ($1,'hns',$2,$3,1,$4::timestamptz)`,
                values: [input.activationId, canonicalRoot, input.communityId, now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.activation.action.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_actions (
                         action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
                         request_hash,sale_namespace_activation_id,expected_activation_generation,
                         result_activation_generation,result_activation_hash,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,1,$8,$9::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  input.communityId,
                  "/communities/:communityId/handle-sale-namespaces",
                  input.idempotencyKey,
                  hash,
                  input.activationId,
                  activationHash,
                  now,
                ],
                readonly: false,
              });
              const result = yield* readActivation(transaction, input.activationId, 1);
              return {
                activation: activationFromRow(one(result.rows, "created activation")),
                replayed: false,
              };
            }),
          ),
        );
      }),
    reviseSaleNamespace: (input: Parameters<HandleSalesStore["reviseSaleNamespace"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint =
                "/communities/:communityId/handle-sale-namespaces/:activationId/revisions";
              const hash = requestHash("pirate-handle-sale-namespace-revise-request-v1", {
                account_id: input.accountId,
                community_id: input.communityId,
                activation_id: input.activationId,
                idempotency_key: input.idempotencyKey,
                expected_activation_hash: input.expectedActivationHash,
                requested_status: input.requestedStatus,
                namespace_authority_reference: input.namespaceAuthorityReference,
                expected_namespace_authority_generation: input.expectedNamespaceAuthorityGeneration,
                dns_zone_activation_id: input.dnsZoneActivationId,
                expected_dns_zone_activation_generation: input.expectedDnsZoneActivationGeneration,
                dedicated_root_replacement_confirmed: input.dedicatedRootReplacementConfirmed,
              });
              const replay = yield* mutationReplay(
                transaction,
                "community_handle_sale_namespace_activation_actions",
                input.accountId,
                endpoint,
                input.idempotencyKey,
              );
              if (replay.rows[0] !== undefined) {
                const row = replay.rows[0];
                if (
                  text(row, "request_hash") !== hash ||
                  text(row, "community_id") !== input.communityId
                ) {
                  return yield* reject("idempotency_conflict");
                }
                const result = yield* readActivation(
                  transaction,
                  text(row, "sale_namespace_activation_id"),
                  integer(row, "result_activation_generation"),
                );
                return {
                  activation: activationFromRow(one(result.rows, "activation replay")),
                  replayed: true,
                };
              }
              const current = yield* transaction.execute<Row>({
                label: "handle-sales.activation.current.lock",
                text: `${ACTIVATION_SELECT}
                       JOIN community_handle_sale_namespace_activation_current AS current_activation
                         ON current_activation.sale_namespace_activation_id=revision.sale_namespace_activation_id
                        AND current_activation.current_generation=revision.sale_namespace_activation_generation
                      WHERE revision.sale_namespace_activation_id=$1
                        AND revision.community_id=$2
                      FOR UPDATE OF current_activation`,
                values: [input.activationId, input.communityId],
                readonly: false,
              });
              if (current.rows[0] === undefined)
                return yield* reject("sale_namespace_inactive", true);
              const prior = activationFromRow(current.rows[0]);
              if (prior.sale_namespace_activation_hash !== input.expectedActivationHash) {
                return yield* reject("sale_namespace_inactive", true);
              }
              yield* Effect.try({
                try: () => transitionHandleSaleActivationV1(prior.status, input.requestedStatus),
                catch: () => reject("sale_namespace_inactive"),
              });
              const authority = yield* transaction.execute<Row>({
                label: "handle-sales.activation.authority.read",
                text: `SELECT grant_id FROM community_handle_sales_authority_grants
                        WHERE community_id=$1 AND principal_account_id=$2
                          AND authority='manage_handle_sales' AND status='active' FOR SHARE`,
                values: [input.communityId, input.accountId],
                readonly: false,
              });
              if (authority.rows[0] === undefined) return yield* reject("sale_namespace_inactive");
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              if (input.requestedStatus === "active") {
                const dependency = yield* transaction.execute<Row>({
                  label: "handle-sales.activation.dependency.read",
                  text: `SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,$6::timestamptz)`,
                  values: [
                    input.communityId,
                    input.namespaceAuthorityReference,
                    input.expectedNamespaceAuthorityGeneration,
                    input.dnsZoneActivationId,
                    input.expectedDnsZoneActivationGeneration,
                    now,
                  ],
                  readonly: false,
                });
                const dependencyRow = dependency.rows[0];
                if (
                  dependencyRow === undefined ||
                  text(dependencyRow, "canonical_root") !== prior.canonical_root ||
                  !boolean(dependencyRow, "dns_delegation_current")
                ) {
                  return yield* reject("dns_delegation_required", true);
                }
              }
              const generation = prior.sale_namespace_activation_generation + 1;
              const activationHash = handleSaleNamespaceActivationHash({
                sale_namespace_activation_id: input.activationId,
                sale_namespace_activation_generation: generation,
                community_id: input.communityId,
                family: "hns",
                canonical_root: prior.canonical_root,
                namespace_authority_reference: input.namespaceAuthorityReference,
                namespace_authority_generation: input.expectedNamespaceAuthorityGeneration,
                dns_zone_activation_id: input.dnsZoneActivationId,
                dns_zone_activation_generation: input.expectedDnsZoneActivationGeneration,
              }).sha256;
              const activatedAt = prior.activated_at ?? now;
              yield* transaction.execute({
                label: "handle-sales.activation.revision.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_revisions (
                         sale_namespace_activation_id,sale_namespace_activation_generation,
                         sale_namespace_activation_hash,community_id,family,canonical_root,display_root,
                         namespace_authority_kind,namespace_authority_reference,
                         namespace_authority_generation,serving_kind,dns_zone_activation_id,
                         dns_zone_activation_generation,root_replacement_kind,
                         dedicated_root_replacement_confirmed,status,reason_code,actor_account_id,
                         authority_grant_id,created_at,activated_at,suspended_at,revoked_at,recorded_at
                       ) VALUES (
                         $1,$2,$3,$4,'hns',$5,$6,'verified_namespace_v1',$7,$8,
                         'hns_dns_zone_activation_v1',$9,$10,'dedicated_root_replace_v1',TRUE,
                         $11,$12,$13,$14,$15::timestamptz,$16::timestamptz,$17::timestamptz,
                         $18::timestamptz,$19::timestamptz
                       )`,
                values: [
                  input.activationId,
                  generation,
                  activationHash,
                  input.communityId,
                  prior.canonical_root,
                  prior.display_root,
                  input.namespaceAuthorityReference,
                  input.expectedNamespaceAuthorityGeneration,
                  input.dnsZoneActivationId,
                  input.expectedDnsZoneActivationGeneration,
                  input.requestedStatus,
                  input.requestedStatus === "active" ? null : "seller_transition",
                  input.accountId,
                  text(one(authority.rows, "sales authority"), "grant_id"),
                  prior.created_at,
                  activatedAt,
                  input.requestedStatus === "suspended" ? now : null,
                  input.requestedStatus === "revoked" ? now : null,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.activation.current.update",
                text: `UPDATE community_handle_sale_namespace_activation_current
                          SET current_generation=$2,updated_at=$3::timestamptz
                        WHERE sale_namespace_activation_id=$1`,
                values: [input.activationId, generation, now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.activation.action.insert",
                text: `INSERT INTO community_handle_sale_namespace_activation_actions (
                         action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
                         request_hash,sale_namespace_activation_id,expected_activation_generation,
                         result_activation_generation,result_activation_hash,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  input.communityId,
                  endpoint,
                  input.idempotencyKey,
                  hash,
                  input.activationId,
                  prior.sale_namespace_activation_generation,
                  generation,
                  activationHash,
                  now,
                ],
                readonly: false,
              });
              const result = yield* readActivation(transaction, input.activationId, generation);
              return {
                activation: activationFromRow(one(result.rows, "revised activation")),
                replayed: false,
              };
            }),
          ),
        );
      }),
    listSaleNamespaces: (input: Parameters<HandleSalesStore["listSaleNamespaces"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const paging = yield* Effect.try({
          try: () => ({
            limit: pageLimit(input.limit),
            cursor: decodePageCursor(input.cursor, "activations", input.communityId),
          }),
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : pageRejected("invalid_cursor"),
        });
        const cutoff =
          paging.cursor?.snapshotCutoff ??
          instant(
            one(
              (yield* mapped(
                db.execute<Row>({
                  label: "handle-sales.activation.list-clock",
                  text: "SELECT clock_timestamp() AS database_now",
                  values: [],
                  readonly: true,
                }),
              )).rows,
              "activation list clock",
            ).database_now,
          );
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.activation.list-public",
            text: `${ACTIVATION_SELECT}
                   JOIN community_handle_sale_namespace_activation_current AS current_activation
                     ON current_activation.sale_namespace_activation_id=revision.sale_namespace_activation_id
                    AND current_activation.current_generation=revision.sale_namespace_activation_generation
                  WHERE revision.community_id=$1 AND revision.status='active'
                    AND EXISTS (
                      SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                        revision.sale_namespace_activation_id,$2::timestamptz
                      )
                    )
                    AND revision.created_at <= $2::timestamptz
                    AND (
                      $3::timestamptz IS NULL
                      OR (revision.created_at,revision.sale_namespace_activation_id)
                         < ($3::timestamptz,$4)
                    )
                  ORDER BY revision.created_at DESC,revision.sale_namespace_activation_id DESC
                  LIMIT $5`,
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
        return yield* Effect.try({
          try: () => {
            const selectedRows = result.rows.slice(0, paging.limit);
            const selected = selectedRows.map(activationFromRow);
            const last = selectedRows[selectedRows.length - 1];
            return {
              items: selected,
              next_cursor:
                result.rows.length > paging.limit && last !== undefined
                  ? encodePageCursor("activations", input.communityId, {
                      snapshotCutoff: cutoff,
                      sortTime: instant(last.created_at),
                      sortId: text(last, "sale_namespace_activation_id"),
                    })
                  : null,
            };
          },
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : storage("invalid-row"),
        });
      }),
    createRecipientToken: (input: Parameters<HandleSalesStore["createRecipientToken"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/communities/:communityId/handle-direct-grant-recipient-tokens";
              yield* purgeExpiredRecipientTokens(transaction);
              const hash = handleDirectGrantRecipientTokenRequestHash({
                actor_account_id: input.accountId,
                community_id: input.communityId,
                idempotency_key: input.idempotencyKey,
              }).sha256;
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.recipient-token.replay.read",
                text: `SELECT action.request_hash,action.community_id,token.token_id,
                              token.token_ciphertext,token.token_envelope_key_version,
                              token.expires_at
                         FROM handle_direct_grant_recipient_token_actions AS action
                         JOIN handle_direct_grant_recipient_tokens AS token
                           ON token.token_id=action.token_id
                        WHERE action.actor_account_id=$1
                          AND action.endpoint_template=$2
                          AND action.idempotency_key=$3
                        FOR UPDATE OF action,token`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                const row = replay.rows[0];
                if (
                  text(row, "request_hash") !== hash ||
                  text(row, "community_id") !== input.communityId
                ) {
                  return yield* reject("idempotency_conflict");
                }
                if (row.token_ciphertext === null || row.token_envelope_key_version === null) {
                  return yield* reject("service_unavailable", true);
                }
                const tokenId = text(row, "token_id");
                return {
                  sealed: {
                    keyVersion: text(row, "token_envelope_key_version"),
                    ciphertext: bytes(row.token_ciphertext),
                  },
                  associatedData: JSON.stringify([
                    "pirate-handle-recipient-token-envelope-v1",
                    input.accountId,
                    input.communityId,
                    input.idempotencyKey,
                    tokenId,
                  ]),
                  expiresAt: instant(row.expires_at),
                  replayed: true,
                };
              }
              const currentLookup = input.lookups[0];
              if (currentLookup === undefined) return yield* reject("service_unavailable", true);
              yield* advisoryLock(
                transaction,
                53_002,
                [input.accountId, input.communityId],
                "handle-sales.recipient-token.scope.lock",
              );
              const account = yield* transaction.execute<Row>({
                label: "handle-sales.recipient-token.account.read",
                text: `SELECT user_id FROM users WHERE user_id=$1 AND status='active' FOR SHARE`,
                values: [input.accountId],
                readonly: false,
              });
              const community = yield* transaction.execute<Row>({
                label: "handle-sales.recipient-token.community.read",
                text: `SELECT community_id FROM communities
                        WHERE community_id=$1 AND status='active' FOR SHARE`,
                values: [input.communityId],
                readonly: false,
              });
              if (account.rows[0] === undefined || community.rows[0] === undefined) {
                return yield* reject("service_unavailable");
              }
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              yield* transaction.execute({
                label: "handle-sales.recipient-token.supersede",
                text: `UPDATE handle_direct_grant_recipient_tokens
                          SET status='superseded',superseded_at=$3::timestamptz
                        WHERE recipient_account_id=$1 AND community_id=$2 AND status='current'`,
                values: [input.accountId, input.communityId, now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.recipient-token.insert",
                text: `INSERT INTO handle_direct_grant_recipient_tokens (
                         token_id,recipient_account_id,community_id,token_lookup_digest,
                         token_hmac_key_version,token_ciphertext,token_envelope_key_version,
                         status,created_at,expires_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'current',$8::timestamptz,
                                 $8::timestamptz + interval '600 seconds')`,
                values: [
                  input.tokenId,
                  input.accountId,
                  input.communityId,
                  currentLookup.digest,
                  currentLookup.keyVersion,
                  input.sealed.ciphertext,
                  input.sealed.keyVersion,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.recipient-token.action.insert",
                text: `INSERT INTO handle_direct_grant_recipient_token_actions (
                         action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
                         request_hash,token_id,token_lookup_digest,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  input.communityId,
                  endpoint,
                  input.idempotencyKey,
                  hash,
                  input.tokenId,
                  currentLookup.digest,
                  now,
                ],
                readonly: false,
              });
              return {
                sealed: input.sealed,
                associatedData: JSON.stringify([
                  "pirate-handle-recipient-token-envelope-v1",
                  input.accountId,
                  input.communityId,
                  input.idempotencyKey,
                  input.tokenId,
                ]),
                expiresAt: new Date(Date.parse(now) + 600_000).toISOString(),
                replayed: false,
              };
            }),
          ),
        );
      }),
    createQualificationPolicy: (
      input: Parameters<HandleSalesStore["createQualificationPolicy"]>[0],
    ) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/communities/:communityId/handle-qualification-policies";
              const authority = yield* transaction.execute<Row>({
                label: "handle-sales.policy.authority.read",
                text: `SELECT grant_id FROM community_handle_sales_authority_grants
                        WHERE community_id=$1 AND principal_account_id=$2
                          AND authority='manage_handle_sales' AND status='active' FOR SHARE`,
                values: [input.communityId, input.accountId],
                readonly: false,
              });
              if (authority.rows[0] === undefined) return yield* reject("offering_unavailable");
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.policy.replay.read",
                text: `SELECT action.*,policy.policy_kind,policy.policy_hash,
                              policy.provider_binding_hash,policy.provider_binding_version,
                              policy.created_at
                         FROM handle_qualification_policy_actions AS action
                         JOIN handle_qualification_policy_revisions AS policy
                           ON policy.policy_id=action.policy_id
                          AND policy.policy_revision=action.policy_revision
                        WHERE action.actor_account_id=$1
                          AND action.endpoint_template=$2
                          AND action.idempotency_key=$3
                        FOR UPDATE OF action`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                const row = replay.rows[0];
                const digestMatches = input.recipientTokenLookups.some(
                  (candidate) =>
                    candidate.keyVersion === text(row, "submitted_token_hmac_key_version") &&
                    candidate.digest === text(row, "submitted_token_lookup_digest"),
                );
                if (
                  !digestMatches ||
                  text(row, "community_id") !== input.communityId ||
                  text(row, "provider_binding_version") !==
                    input.expectedAccountDirectoryBindingVersion
                ) {
                  return yield* reject("idempotency_conflict");
                }
                return {
                  kind: "account_allowlist_policy_authored_v2" as const,
                  request_hash: text(row, "request_hash"),
                  qualification_policy: {
                    kind: "curated_policy_v1" as const,
                    policy_id: text(row, "policy_id"),
                    policy_revision: integer(row, "policy_revision"),
                    policy_hash: text(row, "policy_hash"),
                    provider_binding_hash: text(row, "provider_binding_hash"),
                  },
                  created_at: instant(row.created_at),
                  replayed: true,
                };
              }
              yield* purgeExpiredRecipientTokens(transaction);
              const binding = yield* transaction.execute<Row>({
                label: "handle-sales.policy.binding.read",
                text: `SELECT binding_version,binding_hash
                         FROM handle_account_directory_bindings
                        WHERE binding_kind='account_directory_v1'
                          AND binding_version=$1 AND status='active' FOR SHARE`,
                values: [input.expectedAccountDirectoryBindingVersion],
                readonly: false,
              });
              if (binding.rows[0] === undefined) return yield* reject("offering_unavailable", true);
              const versions = input.recipientTokenLookups.map(({ keyVersion }) => keyVersion);
              const digests = input.recipientTokenLookups.map(({ digest }) => digest);
              const tokenResult = yield* transaction.execute<Row>({
                label: "handle-sales.policy.recipient-token.lock",
                text: `SELECT token.*
                         FROM handle_direct_grant_recipient_tokens AS token
                         JOIN users AS recipient ON recipient.user_id=token.recipient_account_id
                        WHERE (token.token_hmac_key_version,token.token_lookup_digest) IN (
                          SELECT * FROM unnest($1::text[],$2::text[])
                        )
                          AND token.community_id=$3
                          AND token.status='current'
                          AND token.expires_at > clock_timestamp()
                          AND recipient.status='active'
                        FOR UPDATE OF token`,
                values: [versions, digests, input.communityId],
                readonly: false,
              });
              if (tokenResult.rows[0] === undefined) {
                return yield* new HandleDirectGrantRecipientUnavailable({});
              }
              const token = tokenResult.rows[0];
              const request = handleAccountAllowlistPolicyRequestV2Hash({
                actor_account_id: input.accountId,
                community_id: input.communityId,
                resolved_subject_account_id: text(token, "recipient_account_id"),
                expected_account_directory_binding_version:
                  input.expectedAccountDirectoryBindingVersion,
                idempotency_key: input.idempotencyKey,
              }).sha256;
              const policyHash = handleAccountAllowlistPolicyHash({
                policy_id: input.policyId,
                policy_revision: 1,
                requirement_id: input.requirementId,
                requirement_revision: 1,
                subject_account_id: text(token, "recipient_account_id"),
                binding_version: text(
                  one(binding.rows, "account directory binding"),
                  "binding_version",
                ),
                binding_hash: text(one(binding.rows, "account directory binding"), "binding_hash"),
              }).sha256;
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              yield* transaction.execute({
                label: "handle-sales.policy.insert",
                text: `INSERT INTO handle_qualification_policy_revisions (
                         policy_id,policy_revision,community_id,policy_kind,request_hash,policy_hash,
                         requirement_id,requirement_revision,requirement_kind,subject_account_id,
                         provider_binding_kind,provider_binding_version,provider_binding_hash,
                         status,created_by_account_id,created_at
                       ) VALUES ($1,1,$2,'curated_policy_v1',$3,$4,$5,1,'account_allowlist_v1',
                                 $6,'account_directory_v1',$7,$8,'active',$9,$10::timestamptz)`,
                values: [
                  input.policyId,
                  input.communityId,
                  request,
                  policyHash,
                  input.requirementId,
                  text(token, "recipient_account_id"),
                  input.expectedAccountDirectoryBindingVersion,
                  text(one(binding.rows, "account directory binding"), "binding_hash"),
                  input.accountId,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.policy.action.insert",
                text: `INSERT INTO handle_qualification_policy_actions (
                         action_id,actor_account_id,community_id,endpoint_template,idempotency_key,
                         request_hash,submitted_token_hmac_key_version,
                         submitted_token_lookup_digest,policy_id,policy_revision,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  input.communityId,
                  endpoint,
                  input.idempotencyKey,
                  request,
                  text(token, "token_hmac_key_version"),
                  text(token, "token_lookup_digest"),
                  input.policyId,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.policy.recipient-token.consume",
                text: `DELETE FROM handle_direct_grant_recipient_tokens
                        WHERE token_id=$1 AND status='current'`,
                values: [text(token, "token_id")],
                readonly: false,
              });
              return {
                kind: "account_allowlist_policy_authored_v2" as const,
                request_hash: request,
                qualification_policy: {
                  kind: "curated_policy_v1" as const,
                  policy_id: input.policyId,
                  policy_revision: 1,
                  policy_hash: policyHash,
                  provider_binding_hash: text(
                    one(binding.rows, "account directory binding"),
                    "binding_hash",
                  ),
                },
                created_at: now,
                replayed: false,
              };
            }),
          ),
        );
      }),
    createOffering: (input: Parameters<HandleSalesStore["createOffering"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            mutateOffering(transaction, input, "/communities/:communityId/handle-offerings"),
          ),
        );
      }),
    reviseOffering: (input: Parameters<HandleSalesStore["reviseOffering"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            mutateOffering(
              transaction,
              input,
              "/communities/:communityId/handle-offerings/:offeringId/revisions",
            ),
          ),
        );
      }),
    listOfferings: (input: Parameters<HandleSalesStore["listOfferings"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const paging = yield* Effect.try({
          try: () => ({
            limit: pageLimit(input.limit),
            cursor: decodePageCursor(input.cursor, "offerings", input.communityId),
          }),
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : pageRejected("invalid_cursor"),
        });
        const cutoff =
          paging.cursor?.snapshotCutoff ??
          instant(
            one(
              (yield* mapped(
                db.execute<Row>({
                  label: "handle-sales.offering.list-clock",
                  text: "SELECT clock_timestamp() AS database_now",
                  values: [],
                  readonly: true,
                }),
              )).rows,
              "offering list clock",
            ).database_now,
          );
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.offering.list-public",
            text: `${OFFERING_SELECT}
                   JOIN community_handle_offering_current AS current_offering
                     ON current_offering.offering_id=revision.offering_id
                    AND current_offering.current_revision=revision.offering_revision
                  WHERE revision.community_id=$1 AND revision.status='active'
                    AND EXISTS (
                      SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                        revision.sale_namespace_activation_id,$2::timestamptz
                      )
                    )
                    AND revision.created_at <= $2::timestamptz
                    AND (
                      $3::timestamptz IS NULL
                      OR (revision.created_at,revision.offering_id) < ($3::timestamptz,$4)
                    )
                  ORDER BY revision.created_at DESC,revision.offering_id DESC
                  LIMIT $5`,
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
        return yield* Effect.try({
          try: () => {
            const selectedRows = result.rows.slice(0, paging.limit);
            const selected = selectedRows.map(offeringFromRow);
            const last = selectedRows[selectedRows.length - 1];
            return {
              items: selected,
              next_cursor:
                result.rows.length > paging.limit && last !== undefined
                  ? encodePageCursor("offerings", input.communityId, {
                      snapshotCutoff: cutoff,
                      sortTime: instant(last.created_at),
                      sortId: text(last, "offering_id"),
                    })
                  : null,
            };
          },
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : storage("invalid-row"),
        });
      }),
    confirmPersonaReuse: (input: Parameters<HandleSalesStore["confirmPersonaReuse"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/handle-persona-link-confirmations";
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.link-confirmation.replay.read",
                text: `SELECT action.request_hash,confirmation.*
                         FROM handle_persona_link_confirmation_actions AS action
                         JOIN handle_persona_link_confirmations AS confirmation
                           ON confirmation.confirmation_id=action.confirmation_id
                        WHERE action.actor_account_id=$1
                          AND action.endpoint_template=$2
                          AND action.idempotency_key=$3
                        FOR UPDATE OF action`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                const row = replay.rows[0];
                const expected = handlePersonaLinkConfirmationRequestHash({
                  actor_account_id: input.accountId,
                  persona_id: input.personaId,
                  offering_id: input.offeringId,
                  target_community_id: text(row, "target_community_id"),
                  family: text(row, "family") as "hns" | "spaces",
                  namespace_root: text(row, "namespace_root"),
                  persona_public_identity_digest: text(row, "persona_public_identity_digest"),
                  idempotency_key: input.idempotencyKey,
                }).sha256;
                if (text(row, "request_hash") !== expected)
                  return yield* reject("idempotency_conflict");
                return {
                  confirmation_id: text(row, "confirmation_id"),
                  confirmation_hash: text(row, "confirmation_hash"),
                  persona_id: text(row, "persona_id"),
                  offering_id: text(row, "offering_id"),
                  target_community_id: text(row, "target_community_id"),
                  family: text(row, "family") as "hns" | "spaces",
                  namespace_root: text(row, "namespace_root"),
                  public_linkage_generation: integer(row, "public_linkage_generation"),
                  persona_public_identity_digest: text(row, "persona_public_identity_digest"),
                  status: "available" as const,
                  confirmed_at: instant(row.confirmed_at),
                  expires_at: instant(row.expires_at),
                  replayed: true,
                };
              }
              const target = yield* transaction.execute<Row>({
                label: "handle-sales.link-confirmation.target.read",
                text: `SELECT revision.*,policy.policy_kind,policy.subject_account_id,
                              linkage.public_linkage_generation
                         FROM community_handle_offering_revisions AS revision
                         JOIN handle_qualification_policy_revisions AS policy
                           ON policy.policy_id=revision.qualification_policy_id
                          AND policy.policy_revision=revision.qualification_policy_revision
                       JOIN community_handle_offering_current AS current_offering
                         ON current_offering.offering_id=revision.offering_id
                        AND current_offering.current_revision=revision.offering_revision
                       JOIN handle_persona_public_linkage_states AS linkage
                         ON linkage.persona_id=$2 AND linkage.account_id=$3
                       JOIN personas AS persona ON persona.persona_id=linkage.persona_id
                      WHERE revision.offering_id=$1 AND revision.status='active'
                        AND persona.status='active'
                      FOR SHARE OF revision,linkage,persona`,
                values: [input.offeringId, input.personaId, input.accountId],
                readonly: false,
              });
              if (target.rows[0] === undefined) return yield* reject("persona_unavailable");
              const row = target.rows[0];
              const generation = integer(row, "public_linkage_generation");
              const identityDigest = handlePersonaPublicIdentityHash({
                persona_id: input.personaId,
                public_linkage_generation: generation,
              }).sha256;
              const confirmationHash = handlePersonaLinkConfirmationRequestHash({
                actor_account_id: input.accountId,
                persona_id: input.personaId,
                offering_id: input.offeringId,
                target_community_id: text(row, "community_id"),
                family: text(row, "family") as "hns" | "spaces",
                namespace_root: text(row, "namespace_root"),
                persona_public_identity_digest: identityDigest,
                idempotency_key: input.idempotencyKey,
              }).sha256;
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              yield* transaction.execute({
                label: "handle-sales.link-confirmation.insert",
                text: `INSERT INTO handle_persona_link_confirmations (
                         confirmation_id,confirmation_hash,actor_account_id,persona_id,offering_id,
                         target_community_id,family,namespace_root,public_linkage_generation,
                         persona_public_identity_digest,status,confirmed_at,expires_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'available',$11::timestamptz,
                                 $11::timestamptz + interval '600 seconds')`,
                values: [
                  input.confirmationId,
                  confirmationHash,
                  input.accountId,
                  input.personaId,
                  input.offeringId,
                  text(row, "community_id"),
                  text(row, "family"),
                  text(row, "namespace_root"),
                  generation,
                  identityDigest,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.link-confirmation.action.insert",
                text: `INSERT INTO handle_persona_link_confirmation_actions (
                         action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
                         confirmation_id,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  endpoint,
                  input.idempotencyKey,
                  confirmationHash,
                  input.confirmationId,
                  now,
                ],
                readonly: false,
              });
              return {
                confirmation_id: input.confirmationId,
                confirmation_hash: confirmationHash,
                persona_id: input.personaId,
                offering_id: input.offeringId,
                target_community_id: text(row, "community_id"),
                family: text(row, "family") as "hns" | "spaces",
                namespace_root: text(row, "namespace_root"),
                public_linkage_generation: generation,
                persona_public_identity_digest: identityDigest,
                status: "available" as const,
                confirmed_at: now,
                expires_at: new Date(Date.parse(now) + 600_000).toISOString(),
                replayed: false,
              };
            }),
          ),
        );
      }),
    createQuote: (input: Parameters<HandleSalesStore["createQuote"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/handle-quotes";
              const hash = yield* Effect.try({
                try: () =>
                  handleQuoteRequestHash({
                    actor_account_id: input.accountId,
                    persona_id: input.personaId,
                    offering_id: input.offeringId,
                    desired_label: input.desiredLabel,
                    idempotency_key: input.idempotencyKey,
                  }).sha256,
                catch: () => reject("invalid_handle"),
              });
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.quote.replay.read",
                text: `SELECT * FROM handle_quote_actions
                        WHERE actor_account_id=$1 AND endpoint_template=$2 AND idempotency_key=$3
                        FOR UPDATE`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                const action = replay.rows[0];
                if (text(action, "request_hash") !== hash)
                  return yield* reject("idempotency_conflict");
                if (text(action, "result_kind") === "eligibility_required") {
                  return {
                    kind: "eligibility_required" as const,
                    offering_id: text(action, "offering_id"),
                    owner_persona_id: text(action, "owner_persona_id"),
                    reason: text(action, "eligibility_reason") as
                      | "evidence_required"
                      | "qualification_unsatisfied",
                  };
                }
                const quote = yield* transaction.execute<Row>({
                  label: "handle-sales.quote.read-replay",
                  text: `SELECT * FROM handle_quotes WHERE quote_id=$1`,
                  values: [text(action, "quote_id")],
                  readonly: false,
                });
                return {
                  kind: "quoted" as const,
                  quote: quoteFromRow(one(quote.rows, "quote replay")),
                  replayed: true,
                };
              }
              yield* Effect.try({
                try: () => assertCanonicalHnsHandleLabelV2(input.desiredLabel),
                catch: () => reject("invalid_handle"),
              });
              const requested = yield* transaction.execute<Row>({
                label: "handle-sales.quote.offering.read",
                text: `SELECT revision.*,policy.policy_kind,policy.subject_account_id,
                              linkage.public_linkage_generation
                         FROM community_handle_offering_revisions AS revision
                         JOIN handle_qualification_policy_revisions AS policy
                           ON policy.policy_id=revision.qualification_policy_id
                          AND policy.policy_revision=revision.qualification_policy_revision
                       JOIN community_handle_offering_current AS current_offering
                         ON current_offering.offering_id=revision.offering_id
                        AND current_offering.current_revision=revision.offering_revision
                       JOIN handle_persona_public_linkage_states AS linkage
                         ON linkage.persona_id=$2 AND linkage.account_id=$3
                       JOIN personas AS persona ON persona.persona_id=linkage.persona_id
                      WHERE revision.offering_id=$1 AND revision.status='active'
                        AND persona.status='active'
                      FOR SHARE OF current_offering,linkage,persona`,
                values: [input.offeringId, input.personaId, input.accountId],
                readonly: false,
              });
              if (requested.rows[0] === undefined) return yield* reject("persona_unavailable");
              const requestedOffering = offeringFromRow(requested.rows[0]);
              const activationEffective = yield* transaction.execute<Row>({
                label: "handle-sales.quote.activation-effective.read",
                text: `SELECT sale_namespace_activation_id
                         FROM effective_community_handle_sale_namespace_v1($1,clock_timestamp())`,
                values: [requestedOffering.sale_namespace_activation_id],
                readonly: false,
              });
              if (activationEffective.rows[0] === undefined) {
                return yield* reject("sale_namespace_inactive", true);
              }
              const candidates = yield* transaction.execute<Row>({
                label: "handle-sales.quote.classifier.read",
                text: `${OFFERING_SELECT}
                       JOIN community_handle_offering_current AS current_offering
                         ON current_offering.offering_id=revision.offering_id
                        AND current_offering.current_revision=revision.offering_revision
                      WHERE revision.sale_namespace_activation_id=$1
                        AND revision.status='active'`,
                values: [requestedOffering.sale_namespace_activation_id],
                readonly: false,
              });
              const reserved = yield* transaction.execute<Row>({
                label: "handle-sales.quote.reserved-labels.read",
                text: `SELECT platform_labels,namespace_labels
                         FROM handle_reserved_label_revisions
                        WHERE reserved_labels_id=$1 AND reserved_labels_revision=$2`,
                values: [
                  requestedOffering.label_scope.reserved_labels_id,
                  requestedOffering.label_scope.reserved_labels_revision,
                ],
                readonly: false,
              });
              const reservedRow = one(reserved.rows, "quote reserved labels");
              const classification = classifyEffectiveHandleOfferingV2({
                label: input.desiredLabel,
                platform_reserved_labels: new Set(stringArray(reservedRow.platform_labels)),
                namespace_reserved_labels: new Set(stringArray(reservedRow.namespace_labels)),
                active_offerings: candidates.rows.map((row) => {
                  const candidate = offeringFromRow(row);
                  return { offering_id: candidate.offering_id, label_scope: candidate.label_scope };
                }),
              });
              if (classification.kind === "handle_unavailable")
                return yield* reject("handle_unavailable");
              if (classification.kind === "not_offered") return yield* reject("not_offered");
              if (classification.offering.offering_id !== input.offeringId) {
                return yield* reject(
                  "offering_not_applicable",
                  true,
                  classification.offering.offering_id,
                );
              }
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              const human = yield* activeHumanEvidence(transaction, input.accountId, now);
              const policyRow = requested.rows[0];
              const humanMissing = human.rows[0] === undefined;
              const qualificationMismatch =
                text(policyRow, "policy_kind") === "curated_policy_v1" &&
                text(policyRow, "subject_account_id") !== input.accountId;
              if (humanMissing || qualificationMismatch) {
                const reason: "evidence_required" | "qualification_unsatisfied" = humanMissing
                  ? "evidence_required"
                  : "qualification_unsatisfied";
                yield* transaction.execute({
                  label: "handle-sales.quote.action-ineligible.insert",
                  text: `INSERT INTO handle_quote_actions (
                           action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
                           result_kind,quote_id,offering_id,owner_persona_id,eligibility_reason,committed_at
                         ) VALUES ($1,$2,$3,$4,$5,'eligibility_required',NULL,$6,$7,$8,$9::timestamptz)`,
                  values: [
                    input.actionId,
                    input.accountId,
                    endpoint,
                    input.idempotencyKey,
                    hash,
                    input.offeringId,
                    input.personaId,
                    reason,
                    now,
                  ],
                  readonly: false,
                });
                return {
                  kind: "eligibility_required" as const,
                  offering_id: input.offeringId,
                  owner_persona_id: input.personaId,
                  reason,
                };
              }
              const cap = requestedOffering.max_active_grants_per_account;
              if (cap !== null) {
                const count = yield* transaction.execute<Row>({
                  label: "handle-sales.quote.account-cap.read",
                  text: `SELECT count(*)::bigint AS grant_count
                           FROM handle_grants
                          WHERE owner_account_id=$1 AND offering_id=$2 AND status='active'`,
                  values: [input.accountId, input.offeringId],
                  readonly: false,
                });
                if (integer(one(count.rows, "grant count"), "grant_count") >= cap) {
                  return yield* reject("account_grant_limit_reached");
                }
              }
              const linkageGeneration = integer(requested.rows[0], "public_linkage_generation");
              const identityDigest = handlePersonaPublicIdentityHash({
                persona_id: input.personaId,
                public_linkage_generation: linkageGeneration,
              }).sha256;
              let confirmationId: string | null = null;
              let confirmationHash: string | null = null;
              if (linkageGeneration > 0) {
                const confirmation = yield* transaction.execute<Row>({
                  label: "handle-sales.quote.link-confirmation.lock",
                  text: `SELECT * FROM handle_persona_link_confirmations
                          WHERE actor_account_id=$1 AND persona_id=$2 AND offering_id=$3
                            AND target_community_id=$4 AND family='hns' AND namespace_root=$5
                            AND public_linkage_generation=$6
                            AND persona_public_identity_digest=$7
                            AND status='available' AND expires_at > $8::timestamptz
                          ORDER BY confirmed_at DESC,confirmation_id DESC
                          LIMIT 1 FOR UPDATE`,
                  values: [
                    input.accountId,
                    input.personaId,
                    input.offeringId,
                    requestedOffering.community_id,
                    requestedOffering.namespace_root,
                    linkageGeneration,
                    identityDigest,
                    now,
                  ],
                  readonly: false,
                });
                if (confirmation.rows[0] === undefined) {
                  return yield* reject("public_linking_confirmation_required");
                }
                confirmationId = text(confirmation.rows[0], "confirmation_id");
                confirmationHash = text(confirmation.rows[0], "confirmation_hash");
              }
              const evidenceIds = human.rows.map((row) => text(row, "evidence_receipt_id"));
              const quoteHash = handleQuoteV2Hash({
                quote_id: input.quoteId,
                offering_id: requestedOffering.offering_id,
                offering_revision: requestedOffering.offering_revision,
                offering_hash: requestedOffering.offering_hash,
                sale_namespace_activation_id: requestedOffering.sale_namespace_activation_id,
                sale_namespace_activation_generation:
                  requestedOffering.sale_namespace_activation_generation,
                fulfillment_kind: "hosted_persona_v1",
                owner_persona_id: input.personaId,
                family: "hns",
                namespace_root: requestedOffering.namespace_root,
                handle_label: input.desiredLabel,
                pricing: requestedOffering.pricing,
                eligibility: {
                  decision: "passed",
                  policy_revision: requestedOffering.qualification_policy.policy_revision,
                  policy_hash: requestedOffering.qualification_policy.policy_hash,
                  evidence_use_ids: evidenceIds,
                  evaluated_at: now,
                },
                quoted_at: now,
                expires_at: new Date(
                  Date.parse(now) + requestedOffering.quote_ttl_seconds * 1_000,
                ).toISOString(),
              }).sha256;
              yield* transaction.execute({
                label: "handle-sales.quote.insert",
                text: `INSERT INTO handle_quotes (
                         quote_id,quote_hash,request_hash,actor_account_id,owner_persona_id,
                         offering_id,offering_revision,offering_hash,sale_namespace_activation_id,
                         sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
                         display_root,handle_label,display_identifier,pricing_id,pricing_revision,
                         pricing_hash,atomic_amount,eligibility_policy_revision,eligibility_policy_hash,
                         evidence_use_ids,evaluated_at,public_link_confirmation_id,
                         public_link_confirmation_hash,status,quoted_at,expires_at
                       ) VALUES (
                         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'hosted_persona_v1','hns',$11,$12,$13,
                         $14,$15,$16,$17,0,$18,$19,$20,$21::timestamptz,$22,$23,'quoted',
                         $21::timestamptz,$21::timestamptz + make_interval(secs=>$24)
                       )`,
                values: [
                  input.quoteId,
                  quoteHash,
                  hash,
                  input.accountId,
                  input.personaId,
                  requestedOffering.offering_id,
                  requestedOffering.offering_revision,
                  requestedOffering.offering_hash,
                  requestedOffering.sale_namespace_activation_id,
                  requestedOffering.sale_namespace_activation_generation,
                  requestedOffering.namespace_root,
                  requestedOffering.display_root,
                  input.desiredLabel,
                  `${input.desiredLabel}.${requestedOffering.display_root}`,
                  requestedOffering.pricing.pricing_id,
                  requestedOffering.pricing.pricing_revision,
                  requestedOffering.pricing.pricing_hash,
                  requestedOffering.qualification_policy.policy_revision,
                  requestedOffering.qualification_policy.policy_hash,
                  evidenceIds,
                  now,
                  confirmationId,
                  confirmationHash,
                  requestedOffering.quote_ttl_seconds,
                ],
                readonly: false,
              });
              if (confirmationId !== null) {
                yield* transaction.execute({
                  label: "handle-sales.quote.link-confirmation.consume",
                  text: `UPDATE handle_persona_link_confirmations
                            SET status='consumed',consumed_at=$2::timestamptz,consumed_by_quote_id=$3
                          WHERE confirmation_id=$1 AND status='available'`,
                  values: [confirmationId, now, input.quoteId],
                  readonly: false,
                });
              }
              yield* transaction.execute({
                label: "handle-sales.quote.action.insert",
                text: `INSERT INTO handle_quote_actions (
                         action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
                         result_kind,quote_id,offering_id,owner_persona_id,eligibility_reason,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,'quoted',$6,$7,$8,NULL,$9::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  endpoint,
                  input.idempotencyKey,
                  hash,
                  input.quoteId,
                  input.offeringId,
                  input.personaId,
                  now,
                ],
                readonly: false,
              });
              const quote = yield* transaction.execute<Row>({
                label: "handle-sales.quote.read-created",
                text: `SELECT * FROM handle_quotes WHERE quote_id=$1`,
                values: [input.quoteId],
                readonly: false,
              });
              return {
                kind: "quoted" as const,
                quote: quoteFromRow(one(quote.rows, "created quote")),
                replayed: false,
              };
            }),
          ),
        );
      }),
    createReservation: (input: Parameters<HandleSalesStore["createReservation"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/handle-reservations";
              const hash = handleReservationRequestHash({
                actor_account_id: input.accountId,
                persona_id: input.personaId,
                quote_id: input.quoteId,
                expected_quote_hash: input.expectedQuoteHash,
                idempotency_key: input.idempotencyKey,
              }).sha256;
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.replay.read",
                text: `SELECT action.request_hash,reservation.*
                         FROM handle_reservation_actions AS action
                         JOIN handle_reservations AS reservation
                           ON reservation.reservation_id=action.reservation_id
                        WHERE action.actor_account_id=$1
                          AND action.endpoint_template=$2
                          AND action.idempotency_key=$3
                        FOR UPDATE OF action`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                if (text(replay.rows[0], "request_hash") !== hash) {
                  return yield* reject("idempotency_conflict");
                }
                return {
                  reservation: reservationFromRow(replay.rows[0]),
                  replayed: true,
                };
              }
              const quoteResult = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.quote.lock",
                text: `SELECT quote.*,revision.reservation_ttl_seconds,
                              revision.max_active_grants_per_account,
                              policy.policy_kind,policy.subject_account_id,
                              revision.reserved_labels_id,revision.reserved_labels_revision
                         FROM handle_quotes AS quote
                         JOIN community_handle_offering_revisions AS revision
                           ON revision.offering_id=quote.offering_id
                          AND revision.offering_revision=quote.offering_revision
                         JOIN handle_qualification_policy_revisions AS policy
                           ON policy.policy_id=revision.qualification_policy_id
                          AND policy.policy_revision=revision.qualification_policy_revision
                        WHERE quote.quote_id=$1
                        FOR UPDATE OF quote`,
                values: [input.quoteId],
                readonly: false,
              });
              if (quoteResult.rows[0] === undefined) return yield* reject("quote_expired");
              const quoteRow = quoteResult.rows[0];
              if (
                text(quoteRow, "actor_account_id") !== input.accountId ||
                text(quoteRow, "owner_persona_id") !== input.personaId
              ) {
                return yield* reject("persona_unavailable");
              }
              if (text(quoteRow, "quote_hash") !== input.expectedQuoteHash) {
                return yield* reject("offering_unavailable", true);
              }
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              if (
                text(quoteRow, "status") !== "quoted" ||
                Date.parse(instant(quoteRow.expires_at)) <= Date.parse(now)
              ) {
                if (text(quoteRow, "status") === "quoted") {
                  yield* transaction.execute({
                    label: "handle-sales.reservation.quote.expire",
                    text: `UPDATE handle_quotes SET status='expired'
                            WHERE quote_id=$1 AND status='quoted'`,
                    values: [input.quoteId],
                    readonly: false,
                  });
                }
                return yield* reject("quote_expired");
              }
              const currentOffering = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.offering-current.read",
                text: `SELECT revision.offering_hash
                         FROM community_handle_offering_current AS current_offering
                         JOIN community_handle_offering_revisions AS revision
                           ON revision.offering_id=current_offering.offering_id
                          AND revision.offering_revision=current_offering.current_revision
                        WHERE current_offering.offering_id=$1
                          AND revision.offering_hash=$2 AND revision.status='active'
                          AND EXISTS (
                            SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                              revision.sale_namespace_activation_id,$3::timestamptz
                            )
                          )`,
                values: [text(quoteRow, "offering_id"), text(quoteRow, "offering_hash"), now],
                readonly: false,
              });
              if (currentOffering.rows[0] === undefined) {
                return yield* reject("sale_namespace_inactive", true);
              }
              const persona = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.persona.read",
                text: `SELECT persona_id FROM personas
                        WHERE account_id=$1 AND persona_id=$2 AND status='active' FOR SHARE`,
                values: [input.accountId, input.personaId],
                readonly: false,
              });
              if (persona.rows[0] === undefined) return yield* reject("persona_unavailable");
              const human = yield* activeHumanEvidence(transaction, input.accountId, now);
              if (human.rows[0] === undefined) return yield* reject("evidence_required");
              if (
                text(quoteRow, "policy_kind") === "curated_policy_v1" &&
                text(quoteRow, "subject_account_id") !== input.accountId
              ) {
                return yield* reject("qualification_unsatisfied");
              }
              const cap = nullableInteger(quoteRow, "max_active_grants_per_account");
              if (cap !== null) {
                const count = yield* transaction.execute<Row>({
                  label: "handle-sales.reservation.account-cap.read",
                  text: `SELECT count(*)::bigint AS grant_count FROM handle_grants
                          WHERE owner_account_id=$1 AND offering_id=$2 AND status='active'`,
                  values: [input.accountId, text(quoteRow, "offering_id")],
                  readonly: false,
                });
                if (integer(one(count.rows, "grant count"), "grant_count") >= cap) {
                  return yield* reject("account_grant_limit_reached");
                }
              }
              yield* advisoryLock(
                transaction,
                53_004,
                [
                  text(quoteRow, "family"),
                  text(quoteRow, "namespace_root"),
                  text(quoteRow, "handle_label"),
                ],
                "handle-sales.reservation.key.lock",
              );
              const fence = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.key-fence.read",
                text: `SELECT fence.*,reservation.status AS reservation_status,
                              reservation.expires_at AS reservation_expires_at
                         FROM handle_key_fences AS fence
                         LEFT JOIN handle_reservations AS reservation
                           ON reservation.reservation_id=fence.live_reservation_id
                        WHERE fence.family=$1 AND fence.namespace_root=$2 AND fence.handle_label=$3
                        FOR UPDATE OF fence`,
                values: [
                  text(quoteRow, "family"),
                  text(quoteRow, "namespace_root"),
                  text(quoteRow, "handle_label"),
                ],
                readonly: false,
              });
              if (fence.rows[0] !== undefined) {
                const fenceRow = fence.rows[0];
                if (fenceRow.permanent_grant_id !== null)
                  return yield* reject("handle_unavailable");
                if (
                  fenceRow.live_reservation_id !== null &&
                  text(fenceRow, "reservation_status") === "reserved" &&
                  Date.parse(instant(fenceRow.reservation_expires_at)) > Date.parse(now)
                ) {
                  return yield* reject("handle_unavailable");
                }
                if (fenceRow.live_reservation_id !== null) {
                  yield* transaction.execute({
                    label: "handle-sales.reservation.prior-expire",
                    text: `UPDATE handle_reservations
                              SET status='expired',transitioned_at=$2::timestamptz
                            WHERE reservation_id=$1 AND status='reserved'`,
                    values: [text(fenceRow, "live_reservation_id"), now],
                    readonly: false,
                  });
                }
              }
              const expiresAt = new Date(
                Date.parse(now) + integer(quoteRow, "reservation_ttl_seconds") * 1_000,
              ).toISOString();
              const reservationHash = handleReservationV2Hash({
                reservation_id: input.reservationId,
                quote_id: input.quoteId,
                quote_hash: text(quoteRow, "quote_hash"),
                offering_id: text(quoteRow, "offering_id"),
                offering_hash: text(quoteRow, "offering_hash"),
                sale_namespace_activation_id: text(quoteRow, "sale_namespace_activation_id"),
                sale_namespace_activation_generation: integer(
                  quoteRow,
                  "sale_namespace_activation_generation",
                ),
                fulfillment_kind: "hosted_persona_v1",
                owner_persona_id: input.personaId,
                family: "hns",
                namespace_root: text(quoteRow, "namespace_root"),
                handle_label: text(quoteRow, "handle_label"),
                reserved_at: now,
                expires_at: expiresAt,
              }).sha256;
              yield* transaction.execute({
                label: "handle-sales.reservation.insert",
                text: `INSERT INTO handle_reservations (
                         reservation_id,reservation_hash,request_hash,actor_account_id,owner_persona_id,
                         quote_id,quote_hash,offering_id,offering_hash,sale_namespace_activation_id,
                         sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
                         handle_label,status,reserved_at,expires_at,transitioned_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'hosted_persona_v1','hns',
                                 $12,$13,'reserved',$14::timestamptz,$15::timestamptz,NULL)`,
                values: [
                  input.reservationId,
                  reservationHash,
                  hash,
                  input.accountId,
                  input.personaId,
                  input.quoteId,
                  text(quoteRow, "quote_hash"),
                  text(quoteRow, "offering_id"),
                  text(quoteRow, "offering_hash"),
                  text(quoteRow, "sale_namespace_activation_id"),
                  integer(quoteRow, "sale_namespace_activation_generation"),
                  text(quoteRow, "namespace_root"),
                  text(quoteRow, "handle_label"),
                  now,
                  expiresAt,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.reservation.key-fence.write",
                text: `INSERT INTO handle_key_fences (
                         family,namespace_root,handle_label,live_reservation_id,permanent_grant_id,updated_at
                       ) VALUES ('hns',$1,$2,$3,NULL,$4::timestamptz)
                       ON CONFLICT (family,namespace_root,handle_label) DO UPDATE SET
                         live_reservation_id=EXCLUDED.live_reservation_id,
                         updated_at=EXCLUDED.updated_at`,
                values: [
                  text(quoteRow, "namespace_root"),
                  text(quoteRow, "handle_label"),
                  input.reservationId,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.reservation.quote.consume",
                text: `UPDATE handle_quotes
                          SET status='consumed',consumed_at=$2::timestamptz
                        WHERE quote_id=$1 AND status='quoted'`,
                values: [input.quoteId, now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.reservation.action.insert",
                text: `INSERT INTO handle_reservation_actions (
                         action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
                         reservation_id,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  endpoint,
                  input.idempotencyKey,
                  hash,
                  input.reservationId,
                  now,
                ],
                readonly: false,
              });
              const result = yield* transaction.execute<Row>({
                label: "handle-sales.reservation.read-created",
                text: `SELECT * FROM handle_reservations WHERE reservation_id=$1`,
                values: [input.reservationId],
                readonly: false,
              });
              return {
                reservation: reservationFromRow(one(result.rows, "created reservation")),
                replayed: false,
              };
            }),
          ),
        );
      }),
    submitFreeClaim: (input: Parameters<HandleSalesStore["submitFreeClaim"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* mapped(
          db.withTransaction((transaction) =>
            Effect.gen(function* () {
              const endpoint = "/handle-claims";
              const hash = handleClaimRequestHash({
                actor_account_id: input.accountId,
                persona_id: input.personaId,
                reservation_id: input.reservationId,
                expected_reservation_hash: input.expectedReservationHash,
                idempotency_key: input.idempotencyKey,
              }).sha256;
              const replay = yield* transaction.execute<Row>({
                label: "handle-sales.claim.replay.read",
                text: `SELECT action.request_hash,claim.*,
                              handle_grant.grant_id AS grant_grant_id,
                              handle_grant.grant_generation AS grant_grant_generation,
                              handle_grant.community_id AS grant_community_id,
                              handle_grant.offering_id AS grant_offering_id,
                              handle_grant.offering_hash AS grant_offering_hash,
                              handle_grant.claim_id AS grant_claim_id,
                              handle_grant.owner_persona_id AS grant_owner_persona_id,
                              handle_grant.sale_namespace_activation_id AS grant_sale_namespace_activation_id,
                              handle_grant.sale_namespace_activation_generation AS grant_sale_namespace_activation_generation,
                              handle_grant.namespace_root AS grant_namespace_root,
                              handle_grant.handle_label AS grant_handle_label,
                              handle_grant.display_identifier AS grant_display_identifier,
                              handle_grant.status AS grant_status,
                              handle_grant.issued_at AS grant_issued_at
                         FROM handle_claim_actions AS action
                         JOIN handle_claims AS claim ON claim.claim_id=action.claim_id
                         LEFT JOIN handle_grants AS handle_grant ON handle_grant.grant_id=claim.grant_id
                        WHERE action.actor_account_id=$1
                          AND action.endpoint_template=$2
                          AND action.idempotency_key=$3
                        FOR UPDATE OF action`,
                values: [input.accountId, endpoint, input.idempotencyKey],
                readonly: false,
              });
              if (replay.rows[0] !== undefined) {
                if (text(replay.rows[0], "request_hash") !== hash) {
                  return yield* reject("idempotency_conflict");
                }
                return { claim: claimFromRow(replay.rows[0]), replayed: true };
              }
              const reservationResult = yield* transaction.execute<Row>({
                label: "handle-sales.claim.reservation.lock",
                text: `SELECT reservation.*,quote.display_identifier,quote.pricing_revision,
                              quote.pricing_hash,quote.atomic_amount,quote.offering_revision,
                              revision.max_active_grants_per_account,revision.community_id,
                              policy.policy_kind,policy.subject_account_id
                         FROM handle_reservations AS reservation
                         JOIN handle_quotes AS quote ON quote.quote_id=reservation.quote_id
                         JOIN community_handle_offering_revisions AS revision
                           ON revision.offering_id=quote.offering_id
                          AND revision.offering_revision=quote.offering_revision
                         JOIN handle_qualification_policy_revisions AS policy
                           ON policy.policy_id=revision.qualification_policy_id
                          AND policy.policy_revision=revision.qualification_policy_revision
                        WHERE reservation.reservation_id=$1
                        FOR UPDATE OF reservation`,
                values: [input.reservationId],
                readonly: false,
              });
              if (reservationResult.rows[0] === undefined)
                return yield* reject("reservation_expired");
              const row = reservationResult.rows[0];
              if (
                text(row, "actor_account_id") !== input.accountId ||
                text(row, "owner_persona_id") !== input.personaId
              ) {
                return yield* reject("persona_unavailable");
              }
              if (text(row, "reservation_hash") !== input.expectedReservationHash) {
                return yield* reject("claim_blocked");
              }
              const now = instant(
                one((yield* currentDatabaseTime(transaction)).rows, "database clock").database_now,
              );
              if (
                text(row, "status") !== "reserved" ||
                Date.parse(instant(row.expires_at)) <= Date.parse(now)
              ) {
                if (text(row, "status") === "reserved") {
                  yield* transaction.execute({
                    label: "handle-sales.claim.reservation.expire",
                    text: `UPDATE handle_reservations
                              SET status='expired',transitioned_at=$2::timestamptz
                            WHERE reservation_id=$1 AND status='reserved'`,
                    values: [input.reservationId, now],
                    readonly: false,
                  });
                }
                return yield* reject("reservation_expired");
              }
              const currentOffering = yield* transaction.execute<Row>({
                label: "handle-sales.claim.offering-current.read",
                text: `SELECT revision.offering_hash
                         FROM community_handle_offering_current AS current_offering
                         JOIN community_handle_offering_revisions AS revision
                           ON revision.offering_id=current_offering.offering_id
                          AND revision.offering_revision=current_offering.current_revision
                         JOIN handle_issuance_driver_revisions AS driver
                           ON driver.family=revision.family
                          AND driver.driver_id=revision.issuance_driver_id
                          AND driver.driver_version=revision.issuance_driver_version
                        WHERE current_offering.offering_id=$1
                          AND revision.offering_hash=$2 AND revision.status='active'
                          AND driver.status='enabled'
                          AND EXISTS (
                            SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                              revision.sale_namespace_activation_id,$3::timestamptz
                            )
                          )`,
                values: [text(row, "offering_id"), text(row, "offering_hash"), now],
                readonly: false,
              });
              if (currentOffering.rows[0] === undefined) {
                return yield* reject("sale_namespace_inactive", true);
              }
              const persona = yield* transaction.execute<Row>({
                label: "handle-sales.claim.persona.read",
                text: `SELECT persona_id FROM personas
                        WHERE account_id=$1 AND persona_id=$2 AND status='active' FOR SHARE`,
                values: [input.accountId, input.personaId],
                readonly: false,
              });
              if (persona.rows[0] === undefined) return yield* reject("persona_unavailable");
              const human = yield* activeHumanEvidence(transaction, input.accountId, now);
              if (human.rows[0] === undefined) return yield* reject("evidence_required");
              if (
                text(row, "policy_kind") === "curated_policy_v1" &&
                text(row, "subject_account_id") !== input.accountId
              ) {
                return yield* reject("qualification_unsatisfied");
              }
              yield* advisoryLock(
                transaction,
                53_004,
                ["hns", text(row, "namespace_root"), text(row, "handle_label")],
                "handle-sales.claim.key.lock",
              );
              yield* advisoryLock(
                transaction,
                53_005,
                [input.accountId, text(row, "offering_id")],
                "handle-sales.claim.cap.lock",
              );
              const fence = yield* transaction.execute<Row>({
                label: "handle-sales.claim.key-fence.lock",
                text: `SELECT * FROM handle_key_fences
                        WHERE family='hns' AND namespace_root=$1 AND handle_label=$2
                        FOR UPDATE`,
                values: [text(row, "namespace_root"), text(row, "handle_label")],
                readonly: false,
              });
              const fenceRow = fence.rows[0];
              if (
                fenceRow === undefined ||
                fenceRow.permanent_grant_id !== null ||
                text(fenceRow, "live_reservation_id") !== input.reservationId
              ) {
                return yield* reject("handle_unavailable");
              }
              const cap = nullableInteger(row, "max_active_grants_per_account");
              const count = yield* transaction.execute<Row>({
                label: "handle-sales.claim.account-cap.lock",
                text: `INSERT INTO handle_account_offering_grant_counters (
                         account_id,offering_id,active_grant_count,updated_at
                       ) VALUES ($1,$2,0,$3::timestamptz)
                       ON CONFLICT (account_id,offering_id) DO UPDATE SET
                         updated_at=handle_account_offering_grant_counters.updated_at
                       RETURNING active_grant_count`,
                values: [input.accountId, text(row, "offering_id"), now],
                readonly: false,
              });
              if (
                cap !== null &&
                integer(one(count.rows, "grant counter"), "active_grant_count") >= cap
              ) {
                return yield* reject("account_grant_limit_reached");
              }
              const finalizeHash = handleGrantFinalizeV2Hash({
                claim_id: input.claimId,
                reservation_id: input.reservationId,
                reservation_hash: text(row, "reservation_hash"),
                offering_id: text(row, "offering_id"),
                offering_hash: text(row, "offering_hash"),
                sale_namespace_activation_id: text(row, "sale_namespace_activation_id"),
                sale_namespace_activation_generation: integer(
                  row,
                  "sale_namespace_activation_generation",
                ),
                fulfillment_kind: "hosted_persona_v1",
                family: "hns",
                namespace_root: text(row, "namespace_root"),
                handle_label: text(row, "handle_label"),
                owner_persona_id: input.personaId,
                issuance_operation_id: input.issuanceOperationId,
                claim_request_hash: hash,
              }).sha256;
              yield* transaction.execute({
                label: "handle-sales.claim.insert-issued",
                text: `INSERT INTO handle_claims (
                         claim_id,request_hash,actor_account_id,owner_persona_id,offering_id,
                         offering_hash,quote_id,reservation_id,reservation_hash,
                         sale_namespace_activation_id,sale_namespace_activation_generation,
                         fulfillment_kind,family,namespace_root,handle_label,display_identifier,
                         pricing_revision,pricing_hash,atomic_amount,payment_status,state,safe_reason,
                         issuance_operation_id,grant_finalize_hash,grant_id,created_at,updated_at
                       ) VALUES (
                         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'hosted_persona_v1','hns',$12,$13,
                         $14,$15,$16,0,'not_applicable','issued',NULL,$17,$18,$19,
                         $20::timestamptz,$20::timestamptz
                       )`,
                values: [
                  input.claimId,
                  hash,
                  input.accountId,
                  input.personaId,
                  text(row, "offering_id"),
                  text(row, "offering_hash"),
                  text(row, "quote_id"),
                  input.reservationId,
                  text(row, "reservation_hash"),
                  text(row, "sale_namespace_activation_id"),
                  integer(row, "sale_namespace_activation_generation"),
                  text(row, "namespace_root"),
                  text(row, "handle_label"),
                  text(row, "display_identifier"),
                  integer(row, "pricing_revision"),
                  text(row, "pricing_hash"),
                  input.issuanceOperationId,
                  finalizeHash,
                  input.grantId,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.grant.insert",
                text: `INSERT INTO handle_grants (
                         grant_id,grant_generation,community_id,offering_id,offering_hash,claim_id,
                         owner_account_id,owner_persona_id,sale_namespace_activation_id,
                         sale_namespace_activation_generation,fulfillment_kind,family,namespace_root,
                         handle_label,display_identifier,status,issued_at,updated_at
                       ) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'hosted_persona_v1','hns',$10,$11,
                                 $12,'active',$13::timestamptz,$13::timestamptz)`,
                values: [
                  input.grantId,
                  text(row, "community_id"),
                  text(row, "offering_id"),
                  text(row, "offering_hash"),
                  input.claimId,
                  input.accountId,
                  input.personaId,
                  text(row, "sale_namespace_activation_id"),
                  integer(row, "sale_namespace_activation_generation"),
                  text(row, "namespace_root"),
                  text(row, "handle_label"),
                  text(row, "display_identifier"),
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.claim.reservation.consume",
                text: `UPDATE handle_reservations
                          SET status='consumed',transitioned_at=$2::timestamptz
                        WHERE reservation_id=$1 AND status='reserved'`,
                values: [input.reservationId, now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.claim.key-fence.finalize",
                text: `UPDATE handle_key_fences
                          SET live_reservation_id=NULL,permanent_grant_id=$4,updated_at=$5::timestamptz
                        WHERE family='hns' AND namespace_root=$1 AND handle_label=$2
                          AND live_reservation_id=$3`,
                values: [
                  text(row, "namespace_root"),
                  text(row, "handle_label"),
                  input.reservationId,
                  input.grantId,
                  now,
                ],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.claim.cap.increment",
                text: `UPDATE handle_account_offering_grant_counters
                          SET active_grant_count=active_grant_count+1,updated_at=$3::timestamptz
                        WHERE account_id=$1 AND offering_id=$2`,
                values: [input.accountId, text(row, "offering_id"), now],
                readonly: false,
              });
              yield* transaction.execute({
                label: "handle-sales.claim.action.insert",
                text: `INSERT INTO handle_claim_actions (
                         action_id,actor_account_id,endpoint_template,idempotency_key,request_hash,
                         claim_id,committed_at
                       ) VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz)`,
                values: [
                  input.actionId,
                  input.accountId,
                  endpoint,
                  input.idempotencyKey,
                  hash,
                  input.claimId,
                  now,
                ],
                readonly: false,
              });
              const result = yield* transaction.execute<Row>({
                label: "handle-sales.claim.read-created",
                text: `${CLAIM_SELECT} WHERE claim.claim_id=$1`,
                values: [input.claimId],
                readonly: false,
              });
              return { claim: claimFromRow(one(result.rows, "created claim")), replayed: false };
            }),
          ),
        );
      }),
    getClaim: (input: Parameters<HandleSalesStore["getClaim"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.claim.read-owner",
            text: `${CLAIM_SELECT}
                    WHERE claim.claim_id=$1 AND claim.actor_account_id=$2`,
            values: [input.claimId, input.accountId],
            readonly: true,
          }),
        );
        if (result.rows[0] === undefined) return null;
        return yield* Effect.try({
          try: () => claimFromRow(one(result.rows, "owner claim")),
          catch: () => storage("invalid-row"),
        });
      }),
    listPersonaGrants: (input: Parameters<HandleSalesStore["listPersonaGrants"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const paging = yield* Effect.try({
          try: () => ({
            limit: pageLimit(input.limit),
            cursor: decodePageCursor(input.cursor, "persona_grants", input.personaId),
          }),
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : pageRejected("invalid_cursor"),
        });
        const cutoff =
          paging.cursor?.snapshotCutoff ??
          instant(
            one(
              (yield* mapped(
                db.execute<Row>({
                  label: "handle-sales.grant.list-clock",
                  text: "SELECT clock_timestamp() AS database_now",
                  values: [],
                  readonly: true,
                }),
              )).rows,
              "grant list clock",
            ).database_now,
          );
        const cursorResult =
          paging.cursor === null
            ? null
            : yield* mapped(
                db.execute<Row>({
                  label: "handle-sales.grant.list-cursor",
                  text: `SELECT family,namespace_root,handle_label,grant_id
                           FROM handle_grants
                          WHERE grant_id=$1 AND owner_persona_id=$2
                            AND issued_at=$3::timestamptz
                            AND issued_at <= $4::timestamptz`,
                  values: [paging.cursor.sortId, input.personaId, paging.cursor.sortTime, cutoff],
                  readonly: true,
                }),
              );
        if (cursorResult !== null && cursorResult.rows.length !== 1) {
          return yield* pageRejected("invalid_cursor");
        }
        const cursorGrant = cursorResult?.rows[0] ?? null;
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.grant.list-public-persona",
            text: `SELECT handle_grant.*,public_persona_projection(handle_grant.owner_persona_id) AS owner_persona,
                          EXISTS (
                            SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                              handle_grant.sale_namespace_activation_id,$2::timestamptz
                            ) AS effective
                            WHERE effective.sale_namespace_activation_generation
                                  = handle_grant.sale_namespace_activation_generation
                          ) AS activation_effective
                     FROM handle_grants AS handle_grant
                     JOIN personas AS persona ON persona.persona_id=handle_grant.owner_persona_id
                    WHERE handle_grant.owner_persona_id=$1 AND handle_grant.status='active'
                      AND persona.status='active'
                      AND handle_grant.issued_at <= $2::timestamptz
                      AND (
                        $3::text IS NULL
                        OR (handle_grant.family,handle_grant.namespace_root,
                            handle_grant.handle_label,handle_grant.grant_id)
                           > ($3::text,$4::text,$5::text,$6::text)
                      )
                    ORDER BY handle_grant.family,handle_grant.namespace_root,
                             handle_grant.handle_label,handle_grant.grant_id
                    LIMIT $7`,
            values: [
              input.personaId,
              cutoff,
              cursorGrant === null ? null : text(cursorGrant, "family"),
              cursorGrant === null ? null : text(cursorGrant, "namespace_root"),
              cursorGrant === null ? null : text(cursorGrant, "handle_label"),
              cursorGrant === null ? null : text(cursorGrant, "grant_id"),
              paging.limit + 1,
            ],
            readonly: true,
          }),
        );
        return yield* Effect.try({
          try: () => {
            const selectedRows = result.rows.slice(0, paging.limit);
            const selected = selectedRows.map(publicGrantFromRow);
            const last = selectedRows[selectedRows.length - 1];
            return {
              items: selected,
              next_cursor:
                result.rows.length > paging.limit && last !== undefined
                  ? encodePageCursor("persona_grants", input.personaId, {
                      snapshotCutoff: cutoff,
                      sortTime: instant(last.issued_at),
                      sortId: text(last, "grant_id"),
                    })
                  : null,
            };
          },
          catch: (error) =>
            error instanceof HandleSalesPageRejected ? error : storage("invalid-row"),
        });
      }),
    getPublicGrant: (input: Parameters<HandleSalesStore["getPublicGrant"]>[0]) =>
      Effect.gen(function* () {
        if (input.family !== "hns" || input.namespaceRoot === "pirate") return null;
        const db = yield* ControlPlaneDb;
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.grant.read-public-key",
            text: `SELECT handle_grant.*,public_persona_projection(handle_grant.owner_persona_id) AS owner_persona,
                          EXISTS (
                            SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                              handle_grant.sale_namespace_activation_id,clock_timestamp()
                            ) AS effective
                            WHERE effective.sale_namespace_activation_generation
                                  = handle_grant.sale_namespace_activation_generation
                          ) AS activation_effective
                     FROM handle_grants AS handle_grant
                     JOIN personas AS persona ON persona.persona_id=handle_grant.owner_persona_id
                    WHERE handle_grant.family='hns' AND handle_grant.namespace_root=$1
                      AND handle_grant.handle_label=$2
                      AND handle_grant.status='active' AND persona.status='active'`,
            values: [input.namespaceRoot, input.handleLabel],
            readonly: true,
          }),
        );
        if (result.rows[0] === undefined) return null;
        return yield* Effect.try({
          try: (): PublicHandleGrantV3 => publicGrantFromRow(one(result.rows, "public grant")),
          catch: () => storage("invalid-row"),
        });
      }),
    getPublicPersona: (input: Parameters<HandleSalesStore["getPublicPersona"]>[0]) =>
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        const result = yield* mapped(
          db.execute<Row>({
            label: "handle-sales.persona.read-public-profile",
            text: `SELECT public_persona_projection(persona.persona_id) AS owner_persona,
                          profile.revision AS profile_revision,
                          profile.cover_ref,
                          profile.bio,
                          handle_grant.*
                     FROM personas AS persona
                     JOIN persona_profiles AS profile ON profile.persona_id=persona.persona_id
                     LEFT JOIN LATERAL (
                       SELECT persona_grant.*,
                              EXISTS (
                                SELECT 1 FROM effective_community_handle_sale_namespace_v1(
                                  persona_grant.sale_namespace_activation_id,clock_timestamp()
                                ) AS effective
                                WHERE effective.sale_namespace_activation_generation
                                      = persona_grant.sale_namespace_activation_generation
                              ) AS activation_effective
                         FROM handle_grants AS persona_grant
                        WHERE persona_grant.owner_persona_id=persona.persona_id
                          AND persona_grant.status='active'
                        ORDER BY persona_grant.family,persona_grant.namespace_root,
                                 persona_grant.handle_label,persona_grant.grant_id
                     ) AS handle_grant ON TRUE
                    WHERE persona.persona_id=$1 AND persona.status='active'
                    ORDER BY handle_grant.family NULLS LAST,
                             handle_grant.namespace_root NULLS LAST,
                             handle_grant.handle_label NULLS LAST,
                             handle_grant.grant_id NULLS LAST`,
            values: [input.personaId],
            readonly: true,
          }),
        );
        if (result.rows.length === 0) return null;
        return yield* Effect.try({
          try: (): PublicPersonaProfileV1 => {
            const first = result.rows[0] as Row;
            const persona = publicPersonaFromSql(first.owner_persona);
            if (persona === undefined || persona === null) {
              throw new Error("invalid public persona");
            }
            const grants = result.rows
              .filter((row) => row.grant_id !== null)
              .map(publicGrantFromRow);
            if (
              grants.some(
                (grant) => JSON.stringify(grant.owner_persona) !== JSON.stringify(persona),
              )
            ) {
              throw new Error("public persona grant owner mismatch");
            }
            return {
              persona,
              profile: {
                revision: integer(first, "profile_revision"),
                cover_ref: nullableText(first, "cover_ref"),
                bio: nullableText(first, "bio"),
              },
              handle_grants: grants,
            };
          },
          catch: () => storage("invalid-row"),
        });
      }),
  };
}

export function makeControlPlaneHandleSalesStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): HandleSalesStore {
  const repository = makeControlPlaneHandleSalesRepository();
  const provide = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
    Effect.provide(runtime)(effect);
  const store = {
    createSaleNamespace: (input: Parameters<HandleSalesStore["createSaleNamespace"]>[0]) =>
      provide(repository.createSaleNamespace(input)),
    reviseSaleNamespace: (input: Parameters<HandleSalesStore["reviseSaleNamespace"]>[0]) =>
      provide(repository.reviseSaleNamespace(input)),
    listSaleNamespaces: (input: Parameters<HandleSalesStore["listSaleNamespaces"]>[0]) =>
      provide(repository.listSaleNamespaces(input)),
    createRecipientToken: (input: Parameters<HandleSalesStore["createRecipientToken"]>[0]) =>
      provide(repository.createRecipientToken(input)),
    createQualificationPolicy: (
      input: Parameters<HandleSalesStore["createQualificationPolicy"]>[0],
    ) => provide(repository.createQualificationPolicy(input)),
    createOffering: (input: Parameters<HandleSalesStore["createOffering"]>[0]) =>
      provide(repository.createOffering(input)),
    reviseOffering: (input: Parameters<HandleSalesStore["reviseOffering"]>[0]) =>
      provide(repository.reviseOffering(input)),
    listOfferings: (input: Parameters<HandleSalesStore["listOfferings"]>[0]) =>
      provide(repository.listOfferings(input)),
    confirmPersonaReuse: (input: Parameters<HandleSalesStore["confirmPersonaReuse"]>[0]) =>
      provide(repository.confirmPersonaReuse(input)),
    createQuote: (input: Parameters<HandleSalesStore["createQuote"]>[0]) =>
      provide(repository.createQuote(input)),
    createReservation: (input: Parameters<HandleSalesStore["createReservation"]>[0]) =>
      provide(repository.createReservation(input)),
    submitFreeClaim: (input: Parameters<HandleSalesStore["submitFreeClaim"]>[0]) =>
      provide(repository.submitFreeClaim(input)),
    getClaim: (input: Parameters<HandleSalesStore["getClaim"]>[0]) =>
      provide(repository.getClaim(input)),
    listPersonaGrants: (input: Parameters<HandleSalesStore["listPersonaGrants"]>[0]) =>
      provide(repository.listPersonaGrants(input)),
    getPublicGrant: (input: Parameters<HandleSalesStore["getPublicGrant"]>[0]) =>
      provide(repository.getPublicGrant(input)),
    getPublicPersona: (input: Parameters<HandleSalesStore["getPublicPersona"]>[0]) =>
      provide(repository.getPublicPersona(input)),
  };
  // The repository maps every ControlPlaneError before this boundary. The
  // assertion hides only Effect's conservative union left by withTransaction.
  return store as unknown as HandleSalesStore;
}
