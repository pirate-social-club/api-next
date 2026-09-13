import type { ControlPlaneError, ControlPlaneTransaction } from "@pirate/application";
import { nationalityCeremonyReservationHash } from "@pirate/domain";
import { Data, Effect } from "effect";

type Row = Readonly<Record<string, unknown>>;

export class NationalityCeremonyDataInvalid extends Data.TaggedError(
  "NationalityCeremonyDataInvalid",
) {}

export type NationalityCeremonyAction =
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

export type NationalityCeremonyRequirement = Readonly<{
  readonly actionKind: "community_join" | "handle_claim";
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
 * Resolve or issue the nationality child ceremony for one action intent. The
 * caller owns policy identity and the community-first lock; this store owns
 * generation fencing, provider-switch rebinding, and replay. A live pending
 * attempt for the same provider replays as wait; switching provider issues
 * the next generation as a separately bound ceremony, and an expired attempt
 * is retired as expired before the next generation is issued.
 */
export const resolveOrIssueNationalityCeremony = Effect.fn("resolveOrIssueNationalityCeremony")(
  function* (
    transaction: ControlPlaneTransaction,
    input: NationalityCeremonyRequirement,
    options: Readonly<{ readonly nextCeremonyIntentId?: () => string }> = {},
  ): Effect.fn.Return<
    NationalityCeremonyAction,
    ControlPlaneError | NationalityCeremonyDataInvalid
  > {
    if (
      !validId(input.intentId) ||
      !validId(input.actorId) ||
      !input.acceptedProviderIds.includes(input.selectedProviderId as "self.pass" | "zkpassport") ||
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds <= 0
    ) {
      return yield* Effect.fail(new NationalityCeremonyDataInvalid());
    }

    yield* transaction.execute({
      label: "nationality.ceremony.state.ensure",
      text: `INSERT INTO nationality_requirement_states (
             action_kind, intent_id, requirement_kind, actor_id, status,
             requirement_hash, accepted_provider_ids
           ) VALUES ($1, $2, 'nationality', $3, 'unmet', $4, $5::jsonb)
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
      label: "nationality.ceremony.state.lock",
      text: `SELECT actor_id, status, requirement_hash, accepted_provider_ids,
                   generation, current_provider_id
              FROM nationality_requirement_states
             WHERE action_kind = $1 AND intent_id = $2 AND requirement_kind = 'nationality'
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
      return yield* Effect.fail(new NationalityCeremonyDataInvalid());
    }

    if (row.status === "pending") {
      const attempt = yield* transaction.execute<Row>({
        label: "nationality.ceremony.attempt.current",
        text: `SELECT ceremony_intent_id, provider_id, generation
                 FROM nationality_ceremony_attempts
                WHERE action_kind = $1 AND intent_id = $2
                  AND requirement_kind = 'nationality' AND generation = $3
                  AND expires_at > clock_timestamp()`,
        values: [input.actionKind, input.intentId, row.generation],
        readonly: false,
      });
      const attemptRow = attempt.rows[0];
      const generation = attemptRow === undefined ? null : generationOf(attemptRow.generation);
      if (attempt.rows.length > 1) {
        return yield* Effect.fail(new NationalityCeremonyDataInvalid());
      }
      if (attemptRow !== undefined && generation !== null) {
        if (attemptRow.provider_id === input.selectedProviderId) {
          return {
            kind: "wait",
            ceremonyIntentId: attemptRow.ceremony_intent_id,
            generation,
          };
        }
      } else {
        yield* transaction.execute({
          label: "nationality.ceremony.state.expire",
          text: `UPDATE nationality_requirement_states
                    SET status = 'expired', updated_at = clock_timestamp()
                  WHERE action_kind = $1 AND intent_id = $2
                    AND requirement_kind = 'nationality' AND status = 'pending'`,
          values: [input.actionKind, input.intentId],
          readonly: false,
        });
      }
    }

    const generation = generationOf(row.generation) === null ? 1 : Number(row.generation) + 1;
    const ceremonyIntentId =
      options.nextCeremonyIntentId?.() ??
      `nationality-${input.actionKind}_${globalThis.crypto.randomUUID()}`;
    if (!validId(ceremonyIntentId)) {
      return yield* Effect.fail(new NationalityCeremonyDataInvalid());
    }

    yield* transaction.execute<Row>({
      label: "nationality.ceremony.attempt.insert",
      text: `INSERT INTO nationality_ceremony_attempts (
             ceremony_intent_id, actor_id, action_kind, intent_id, requirement_kind,
             generation, requirement_hash, provider_id, provider_binding_hash,
             provider_configuration_kind, provider_configuration_ref,
             provider_configuration_version, reservation_request_hash,
             reservation_request, expires_at
           ) VALUES ($1, $2, $3, $4, 'nationality', $5, $6, $7, $8, $9, $10, $11, $12,
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
        nationalityCeremonyReservationHash(input.reservationRequest),
        JSON.stringify(input.reservationRequest),
        input.ttlSeconds,
      ],
      readonly: false,
    });

    yield* transaction.execute({
      label: "nationality.ceremony.state.pending",
      text: `UPDATE nationality_requirement_states
                SET status = 'pending', generation = $3,
                    current_ceremony_intent_id = $4, current_provider_id = $5,
                    current_provider_binding_hash = $6,
                    current_provider_configuration_kind = $7,
                    current_provider_configuration_ref = $8,
                    current_provider_configuration_version = $9,
                    updated_at = clock_timestamp()
              WHERE action_kind = $1 AND intent_id = $2
                AND requirement_kind = 'nationality'`,
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
