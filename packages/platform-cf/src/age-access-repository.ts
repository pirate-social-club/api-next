import {
  type AccountAgeCapability,
  AgeAccessStoreError,
  type AgeAccessStoreService,
  ControlPlaneDb,
  type ControlPlaneError,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type Row = Readonly<Record<string, unknown>>;

const text = (row: Row, key: string): string | null =>
  typeof row[key] === "string" ? (row[key] as string) : null;

const failure = (
  operation: "capability" | "attestation",
  reason: "invalid-row" | "conflict" = "invalid-row",
) => new AgeAccessStoreError({ operation, reason });

export const makeControlPlaneAgeAccessRepository = () => ({
  hasMinimumAgeAttestation: (
    input: Parameters<AgeAccessStoreService["hasMinimumAgeAttestation"]>[0],
  ) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "age-access.attestation-exists",
        text: `SELECT EXISTS (
                 SELECT 1
                   FROM account_minimum_age_attestations
                  WHERE account_id = $1
                    AND version = 'minimum-age-attestation-v1'
                    AND minimum_age = 16
                    AND affirmed = true
               ) AS attested`,
        values: [input.accountId],
        readonly: true,
      });
      if (result.rows.length !== 1 || typeof result.rows[0]?.attested !== "boolean") {
        return yield* failure("attestation");
      }
      return result.rows[0].attested;
    }),
  getCapability: (input: Parameters<AgeAccessStoreService["getCapability"]>[0]) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      const result = yield* db.execute<Row>({
        label: "age-access.capability",
        text: `SELECT current_account_age_capability_v1($1) AS capability,
                      evidence.provider_id, evidence.policy_reference,
                      evidence.evidence_expires_at
                 FROM (SELECT 1) AS singleton
                 LEFT JOIN LATERAL (
                   SELECT receipt.provider_id,
                          concat(receipt.provider_configuration_ref, '@',
                                 receipt.provider_configuration_version) AS policy_reference,
                          LEAST(assertion.expires_at, receipt.expires_at) AS evidence_expires_at
                     FROM assertions AS assertion
                     JOIN evidence_receipts AS receipt
                       ON receipt.evidence_receipt_id = assertion.evidence_receipt_id
                      AND receipt.user_id = assertion.user_id
                     JOIN proof_sessions AS session
                       ON session.proof_session_id = receipt.proof_session_id
                      AND session.actor_id = assertion.user_id
                      AND session.status = 'completed'
                      AND session.completed_at = session.terminal_at
                      AND session.intent_id = 'platform.document.age-18'
                     JOIN assertion_bindings AS binding
                       ON binding.binding_group_id = assertion.binding_group_id
                      AND binding.user_id = assertion.user_id
                      AND binding.binding_mode = 'same_subject'
                      AND binding.subject_key_id = assertion.subject_key_id
                     JOIN active_subject_key_bindings AS active_binding
                       ON active_binding.subject_key_id = assertion.subject_key_id
                      AND active_binding.user_id = assertion.user_id
                      AND active_binding.binding_event_id = binding.subject_binding_event_id
                      AND active_binding.binding_epoch = binding.subject_binding_epoch
                    WHERE assertion.user_id = $1
                      AND assertion.claim_id = 'age.minimum'
                      AND assertion.assurance = 'document_zk'
                      AND receipt.provider_id IN ('self.pass', 'self.enterprise', 'zkpassport')
                      AND receipt.subject_key_id = assertion.subject_key_id
                      AND assertion.assertion_value->>'minimum_age' ~ '^(0|[1-9][0-9]*)$'
                      AND (assertion.assertion_value->>'minimum_age')::numeric >= 18
                      AND (assertion.expires_at IS NULL OR assertion.expires_at > clock_timestamp())
                      AND (receipt.expires_at IS NULL OR receipt.expires_at > clock_timestamp())
                      AND NOT EXISTS (
                        SELECT 1 FROM LATERAL (
                          SELECT event.outcome
                            FROM assertion_revalidation_events AS event
                           WHERE event.assertion_id = assertion.assertion_id
                             AND event.user_id = assertion.user_id
                        ORDER BY event.observed_at DESC, event.created_at DESC,
                                 event.assertion_revalidation_event_id DESC
                           LIMIT 1
                        ) AS latest
                        WHERE latest.outcome <> 'accepted'
                      )
                 ORDER BY assertion.observed_at DESC, assertion.assertion_id DESC
                    LIMIT 1
                 ) AS evidence ON current_account_age_capability_v1($1) = 'adult_18'`,
        values: [input.accountId],
        readonly: true,
      });
      if (result.rows.length !== 1) return yield* failure("capability");
      const row = result.rows[0] as Row;
      const capability = text(row, "capability");
      if (capability !== "general" && capability !== "adult_18") {
        return yield* failure("capability");
      }
      const provider = text(row, "provider_id");
      if (
        provider !== null &&
        provider !== "self.pass" &&
        provider !== "self.enterprise" &&
        provider !== "zkpassport"
      ) {
        return yield* failure("capability");
      }
      const acceptedProvider = provider as "self.pass" | "self.enterprise" | "zkpassport" | null;
      return {
        content_rating: capability,
        policy_reference: capability === "adult_18" ? text(row, "policy_reference") : null,
        provider_id: capability === "adult_18" ? acceptedProvider : null,
        evidence_expires_at:
          capability === "adult_18" && row.evidence_expires_at instanceof Date
            ? row.evidence_expires_at.toISOString()
            : null,
        next_action:
          capability === "adult_18"
            ? ({ kind: "none" } as const)
            : ({
                kind: "verify_minimum_age",
                href: "/verification/sessions",
                minimum_age: 18,
              } as const),
      } satisfies AccountAgeCapability;
    }),
  attestMinimumAge: (input: Parameters<AgeAccessStoreService["attestMinimumAge"]>[0]) =>
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* db.withTransaction((transaction) =>
        Effect.gen(function* () {
          yield* transaction.execute({
            label: "age-access.attestation-insert",
            text: `INSERT INTO account_minimum_age_attestations
                    (account_id, version, minimum_age, affirmed)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (account_id) DO NOTHING`,
            values: [
              input.accountId,
              input.attestation.version,
              input.attestation.minimum_age,
              input.attestation.affirmed,
            ],
            readonly: false,
          });
          const result = yield* transaction.execute<Row>({
            label: "age-access.attestation-read",
            text: `SELECT version, minimum_age, affirmed, attested_at
                     FROM account_minimum_age_attestations
                    WHERE account_id = $1 FOR SHARE`,
            values: [input.accountId],
            readonly: true,
          });
          const row = result.rows.length === 1 ? (result.rows[0] as Row) : null;
          if (
            row === null ||
            text(row, "version") !== input.attestation.version ||
            row.minimum_age !== input.attestation.minimum_age ||
            row.affirmed !== true ||
            !(row.attested_at instanceof Date)
          ) {
            return yield* failure("attestation", "conflict");
          }
          return {
            age_attestation_required: false,
            accepted_version: "minimum-age-attestation-v1" as const,
            attested_at: row.attested_at.toISOString(),
          };
        }),
      );
    }),
});

export const makeControlPlaneAgeAccessStore = (
  database: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
): AgeAccessStoreService => {
  const repository = makeControlPlaneAgeAccessRepository();
  return {
    hasMinimumAgeAttestation: (input) =>
      Effect.provide(database)(repository.hasMinimumAgeAttestation(input)),
    getCapability: (input) => Effect.provide(database)(repository.getCapability(input)),
    attestMinimumAge: (input) => Effect.provide(database)(repository.attestMinimumAge(input)),
  };
};
