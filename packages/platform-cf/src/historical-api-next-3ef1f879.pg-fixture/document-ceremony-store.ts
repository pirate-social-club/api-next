import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { ageVerificationReservationHash, nationalityCeremonyReservationHash } from "@pirate/domain";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

export class DocumentCeremonyDataInvalid extends Data.TaggedError("DocumentCeremonyDataInvalid") {}

export type DocumentCeremonyAction =
  | Readonly<{
      readonly kind: "start";
      readonly ceremonyIntentId: string;
      readonly generation: number;
    }>
  | Readonly<{
      readonly kind: "wait";
      readonly ceremonyIntentId: string;
      readonly generation: number;
    }>;

export type DocumentCeremonyRequirement = Readonly<{
  readonly actionKind: "community_join" | "handle_claim" | "community_creation" | "adult_view";
  readonly intentId: string;
  readonly actorId: string;
  readonly requirementHash: string;
  readonly acceptedProviderIds: readonly ["self.pass", "zkpassport"];
  readonly selectedProviderId: string;
  readonly selectedBinding: Readonly<{
    readonly bindingHash: string;
    readonly configurationKind: string;
    readonly configurationRef: string;
    readonly configurationVersion: string;
  }>;
  readonly reservationRequest: Readonly<Record<string, unknown>>;
  readonly ttlSeconds: number;
}>;

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !value.includes("\u0000");

const generationOf = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Resolve or issue a document child ceremony for one action intent. The
 * caller owns policy identity and the parent intent lock; this store owns
 * generation fencing, provider-switch rebinding, and replay in a closed storage namespace. A live pending
 * attempt for the same provider replays as wait; switching provider issues
 * the next generation as a separately bound ceremony, and an expired attempt
 * is retired as expired before the next generation is issued.
 */
export const resolveOrIssueDocumentCeremony = Effect.fn("resolveOrIssueDocumentCeremony")(
  function* (
    transaction: ControlPlaneTransaction,
    input: DocumentCeremonyRequirement,
    options: Readonly<{
      readonly namespace: "nationality" | "age18";
      readonly nextCeremonyIntentId?: () => string;
    }>,
  ): Effect.fn.Return<DocumentCeremonyAction, ControlPlaneError | DocumentCeremonyDataInvalid> {
    const namespace = options.namespace;
    const attemptsTable =
      namespace === "nationality"
        ? "nationality_ceremony_attempts"
        : "age_verification_ceremony_attempts";
    const statesTable =
      namespace === "nationality"
        ? "nationality_requirement_states"
        : "age_verification_requirement_states";
    const requirementKind = namespace === "nationality" ? "nationality" : "age_18";
    const reservationHash =
      namespace === "nationality"
        ? nationalityCeremonyReservationHash
        : ageVerificationReservationHash;
    const validAction =
      namespace === "nationality"
        ? ["community_join", "handle_claim", "community_creation"].includes(input.actionKind)
        : input.actionKind === "adult_view";
    if (
      (namespace !== "nationality" && namespace !== "age18") ||
      !validAction ||
      !validId(input.intentId) ||
      !validId(input.actorId) ||
      !input.acceptedProviderIds.includes(input.selectedProviderId as "self.pass" | "zkpassport") ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds <= 0
    ) {
      return yield* Effect.fail(new DocumentCeremonyDataInvalid());
    }

    yield* transaction.execute({
      label: `${namespace}.ceremony.state.ensure`,
      text: `INSERT INTO ${statesTable} (
             action_kind, intent_id, requirement_kind, actor_id, status,
             requirement_hash, accepted_provider_ids
           ) VALUES ($1, $2, '${requirementKind}', $3, 'unmet', $4, $5::jsonb)
           ON CONFLICT DO NOTHING`,
      values: [
        input.actionKind,
        input.intentId,
        input.actorId,
        input.requirementHash,
        JSON.stringify(input.acceptedProviderIds),
      ],
      readonly: false,
    });

    const state = yield* transaction.execute<Row>({
      label: `${namespace}.ceremony.state.lock`,
      text: `SELECT actor_id, status, requirement_hash, accepted_provider_ids,
                   generation, current_provider_id
              FROM ${statesTable}
             WHERE action_kind = $1 AND intent_id = $2 AND requirement_kind = '${requirementKind}'
               FOR UPDATE`,
      values: [input.actionKind, input.intentId],
      readonly: false,
    });
    const row = state.rows[0];
    if (
      state.rows.length !== 1 ||
      row === undefined ||
      row.actor_id !== input.actorId ||
      row.requirement_hash !== input.requirementHash ||
      row.status === "satisfied"
    ) {
      return yield* Effect.fail(new DocumentCeremonyDataInvalid());
    }

    if (row.status === "pending") {
      const attempt = yield* transaction.execute<Row>({
        label: `${namespace}.ceremony.attempt.current`,
        text: `SELECT attempt.ceremony_intent_id, attempt.provider_id, attempt.generation
                 FROM ${attemptsTable} attempt
                 LEFT JOIN proof_sessions session ON session.intent_id=attempt.ceremony_intent_id
                   AND session.actor_id=attempt.actor_id
                WHERE attempt.action_kind = $1 AND attempt.intent_id = $2
                  AND attempt.requirement_kind = '${requirementKind}' AND attempt.generation = $3
                  AND attempt.expires_at > clock_timestamp()
                  AND (session.proof_session_id IS NULL OR session.status='completed'
                    OR (session.status='pending' AND session.expires_at>clock_timestamp()))`,
        values: [input.actionKind, input.intentId, row.generation],
        readonly: false,
      });
      const attemptRow = attempt.rows[0];
      const generation = attemptRow === undefined ? null : generationOf(attemptRow.generation);
      if (attempt.rows.length > 1) {
        return yield* Effect.fail(new DocumentCeremonyDataInvalid());
      }
      if (attemptRow !== undefined && generation !== null) {
        if (!validId(attemptRow.ceremony_intent_id) || typeof attemptRow.provider_id !== "string") {
          return yield* Effect.fail(new DocumentCeremonyDataInvalid());
        }
        if (attemptRow.provider_id === input.selectedProviderId) {
          return {
            kind: "wait",
            ceremonyIntentId: attemptRow.ceremony_intent_id,
            generation,
          };
        }
      } else {
        yield* transaction.execute({
          label: `${namespace}.ceremony.state.expire`,
          text: `UPDATE ${statesTable}
                    SET status = 'expired', updated_at = clock_timestamp()
                  WHERE action_kind = $1 AND intent_id = $2
                    AND requirement_kind = '${requirementKind}' AND status = 'pending'`,
          values: [input.actionKind, input.intentId],
          readonly: false,
        });
      }
    }

    const generation = generationOf(row.generation) === null ? 1 : Number(row.generation) + 1;
    const ceremonyIntentId =
      options.nextCeremonyIntentId?.() ??
      `${namespace}-${input.actionKind}_${globalThis.crypto.randomUUID()}`;
    if (!validId(ceremonyIntentId)) {
      return yield* Effect.fail(new DocumentCeremonyDataInvalid());
    }

    yield* transaction.execute<Row>({
      label: `${namespace}.ceremony.attempt.insert`,
      text: `INSERT INTO ${attemptsTable} (
             ceremony_intent_id, actor_id, action_kind, intent_id, requirement_kind,
             generation, requirement_hash, provider_id, provider_binding_hash,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, reservation_request_hash,
             reservation_request, expires_at
           ) VALUES ($1, $2, $3, $4, '${requirementKind}', $5, $6, $7, $8, $9, $10, $11, $12,
                     $13::jsonb, clock_timestamp() + make_interval(secs => $14))`,
      values: [
        ceremonyIntentId,
        input.actorId,
        input.actionKind,
        input.intentId,
        generation,
        input.requirementHash,
        input.selectedProviderId,
        input.selectedBinding.bindingHash,
        input.selectedBinding.configurationKind,
        input.selectedBinding.configurationRef,
        input.selectedBinding.configurationVersion,
        reservationHash(input.reservationRequest),
        JSON.stringify(input.reservationRequest),
        input.ttlSeconds,
      ],
      readonly: false,
    });

    yield* transaction.execute({
      label: `${namespace}.ceremony.state.pending`,
      text: `UPDATE ${statesTable}
                SET status = 'pending', generation = $3,
                    current_ceremony_intent_id = $4, current_provider_id = $5,
                    current_provider_binding_hash = $6,
                    current_provider_configuration_kind = $7,
                    current_provider_configuration_ref = $8,
                    current_provider_configuration_version = $9,
                    updated_at = clock_timestamp()
              WHERE action_kind = $1 AND intent_id = $2
                AND requirement_kind = '${requirementKind}'`,
      values: [
        input.actionKind,
        input.intentId,
        generation,
        ceremonyIntentId,
        input.selectedProviderId,
        input.selectedBinding.bindingHash,
        input.selectedBinding.configurationKind,
        input.selectedBinding.configurationRef,
        input.selectedBinding.configurationVersion,
      ],
      readonly: false,
    });
    return { kind: "start", ceremonyIntentId, generation };
  },
);
