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
        text: `SELECT CASE WHEN evidence.provider_id IS NULL THEN 'general' ELSE 'adult_18' END AS capability,
                      evidence.provider_id, evidence.policy_reference, evidence.evidence_expires_at
                 FROM (SELECT 1) AS singleton
                 LEFT JOIN LATERAL current_account_age_evidence_v2($1) AS evidence ON TRUE`,
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
      if (
        capability === "adult_18" &&
        (provider === null ||
          text(row, "policy_reference") === null ||
          (row.evidence_expires_at !== null &&
            (!(row.evidence_expires_at instanceof Date) ||
              !Number.isFinite(row.evidence_expires_at.getTime()))))
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
