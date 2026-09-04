import {
  AuthError,
  type ConfirmPersonaEvmWallet,
  Conflict,
  type CreatePersona,
  InternalError,
  NotFound,
  type PersonaEvmWalletAssignmentV1,
  type PersonaEvmWalletPreparationV1,
  type PersonaRetirementV1,
  type PreparePersonaEvmWallet,
  type PrivatePersonaV1,
  RateLimited,
  type RetirePersona,
} from "@pirate/contracts";
import { Data, Effect, type Schema } from "effect";

export type PersonaCreateBody = Schema.Schema.Type<
  NonNullable<(typeof CreatePersona.request)["body"]>
>;

export type PersonaRecord = PrivatePersonaV1;
export type PersonaWalletPreparation = PersonaEvmWalletPreparationV1;
export type PersonaWalletAssignment = PersonaEvmWalletAssignmentV1;

export type PreparePersonaEvmWalletBody = Schema.Schema.Type<
  NonNullable<(typeof PreparePersonaEvmWallet.request)["body"]>
>;
export type ConfirmPersonaEvmWalletBody = Schema.Schema.Type<
  NonNullable<(typeof ConfirmPersonaEvmWallet.request)["body"]>
>;
export type RetirePersonaBody = Schema.Schema.Type<
  NonNullable<(typeof RetirePersona.request)["body"]>
>;

export type PersonaCreateIntent = Readonly<{
  displayName: string | null;
  bio: string | null;
  preferredLocale: string | null;
  /** Target community the persona is born bound to (spec 014 section 10.2). */
  communityId: string;
}>;

export class PersonaStoreConflict extends Data.TaggedError("PersonaStoreConflict")<{
  readonly reason:
    | "idempotency-mismatch"
    | "identifier-collision"
    | "slot-limit"
    | "membership-required";
}> {}

export class PersonaStoreRateLimited extends Data.TaggedError("PersonaStoreRateLimited")<{
  readonly retryAfterSeconds: number;
}> {}

export interface PersonaStoreService {
  readonly listByAccount: (accountId: string) => Effect.Effect<readonly PersonaRecord[], unknown>;
  readonly findOwned: (input: {
    readonly accountId: string;
    readonly personaId: string;
  }) => Effect.Effect<PersonaRecord | null, unknown>;
  /** The store owns exact replay and must return the first committed result. */
  readonly create: (input: {
    readonly accountId: string;
    readonly idempotencyKey: string;
    /** Replay comparison excludes generated ids and timestamps. */
    readonly intent: PersonaCreateIntent;
    readonly personaId: string;
    readonly createdAt: string;
  }) => Effect.Effect<
    PersonaWalletPreparation,
    PersonaStoreConflict | PersonaStoreRateLimited | unknown
  >;
}

export interface PersonaServices {
  readonly store: PersonaStoreService;
  readonly nextPersonaId: () => Effect.Effect<string, unknown>;
  readonly nowIso: () => Effect.Effect<string, unknown>;
}

export class PersonaWalletStoreConflict extends Data.TaggedError("PersonaWalletStoreConflict")<{
  readonly reason:
    | "idempotency-mismatch"
    | "wallet-index-collision"
    | "wallet-address-collision"
    | "reservation-mismatch"
    | "first-persona-required"
    | "replacement-required";
}> {}

export type EmbeddedEvmWalletAttestation = Readonly<{
  sourceUserId: string;
  privyWalletId: string | null;
  hdWalletIndex: number;
  address: string;
}>;

export class PersonaWalletProofRejected extends Data.TaggedError("PersonaWalletProofRejected")<{
  readonly reason: "invalid" | "unavailable";
}> {}

export interface PersonaWalletProofVerifier {
  /** Verifies the Privy subject and returns only an embedded EVM wallet at the exact index. */
  readonly verifyPrivyEmbeddedEvmWallet: (input: {
    readonly accessToken: string;
    readonly identityToken: string | null;
    readonly hdWalletIndex: number;
  }) => Effect.Effect<EmbeddedEvmWalletAttestation, PersonaWalletProofRejected>;
}

export interface PersonaAccountResolver {
  readonly canonicalAccountId: (sourceUserId: string) => Effect.Effect<string | null, unknown>;
}

export interface PersonaWalletStoreService extends Pick<PersonaStoreService, "findOwned"> {
  /** Atomically rechecks active ownership and allocates an append-only EVM index. */
  readonly reserveEvm: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<PersonaWalletPreparation, PersonaWalletStoreConflict | unknown>;
  readonly getEvmPreparation: (input: {
    readonly accountId: string;
    readonly personaId: string;
  }) => Effect.Effect<PersonaWalletPreparation | null, unknown>;
  /** Atomically rechecks the pending index and global address/index uniqueness. */
  readonly confirmEvm: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly attestation: EmbeddedEvmWalletAttestation;
  }) => Effect.Effect<PersonaWalletAssignment, PersonaWalletStoreConflict | unknown>;
  /**
   * Atomically retires a public persona or cancels a pending one, tombstones
   * its index, and re-designates any current same-community presentation to
   * the designated replacement (spec 014 section 10.3).
   */
  readonly retire: (input: {
    readonly accountId: string;
    readonly personaId: string;
    readonly idempotencyKey: string;
    readonly replacementPersonaId?: string;
  }) => Effect.Effect<PersonaRetirementV1 | null, PersonaWalletStoreConflict | unknown>;
}

export interface PersonaWalletServices {
  readonly store: PersonaWalletStoreService;
  readonly verifier: PersonaWalletProofVerifier;
  readonly accounts: PersonaAccountResolver;
}

export class PersonaUnavailable extends Data.TaggedError("PersonaUnavailable") {}

type PersonaOwnershipStore = Pick<PersonaStoreService, "findOwned">;

const usableId = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && value === value.trim();

/**
 * Shared authority seam for every persona-scoped command. It deliberately
 * collapses missing, foreign, suspended, and retired personas so the caller
 * cannot use an effect endpoint as an ownership oracle.
 */
export const requireActiveOwnedPersona = Effect.fn("requireActiveOwnedPersona")(function* (
  input: Readonly<{ accountId: string; personaId: string }>,
  store: PersonaOwnershipStore,
): Effect.fn.Return<PersonaRecord, PersonaUnavailable | InternalError> {
  if (!usableId(input.accountId) || !usableId(input.personaId)) {
    return yield* new PersonaUnavailable();
  }
  const persona = yield* store
    .findOwned(input)
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona lookup failed" })));
  if (persona === null || persona.status !== "active") {
    return yield* new PersonaUnavailable();
  }
  return persona;
});

export const listMyPersonas = Effect.fn("listMyPersonas")(function* (
  input: Readonly<{ accountId: string }>,
  services: Pick<PersonaServices, "store">,
): Effect.fn.Return<Readonly<{ personas: readonly PersonaRecord[] }>, AuthError | InternalError> {
  if (!usableId(input.accountId)) {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  const personas = yield* services.store
    .listByAccount(input.accountId)
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona lookup failed" })));
  return { personas };
});

export const createPersona = Effect.fn("createPersona")(function* (
  input: Readonly<{ accountId: string; body: PersonaCreateBody }>,
  services: PersonaServices,
): Effect.fn.Return<PersonaWalletPreparation, AuthError | Conflict | InternalError | RateLimited> {
  if (!usableId(input.accountId)) {
    return yield* new AuthError({ message: "Authentication failed" });
  }

  const personaId = yield* services
    .nextPersonaId()
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona creation failed" })));
  const createdAt = yield* services
    .nowIso()
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona creation failed" })));
  if (!usableId(personaId) || !Number.isFinite(Date.parse(createdAt))) {
    return yield* new InternalError({ message: "Persona creation failed" });
  }

  const intent: PersonaCreateIntent = {
    displayName: input.body.display_name ?? null,
    bio: input.body.bio ?? null,
    preferredLocale: input.body.preferred_locale ?? null,
    communityId: input.body.community_id,
  };

  return yield* services.store
    .create({
      accountId: input.accountId,
      idempotencyKey: input.body.idempotency_key,
      intent,
      personaId,
      createdAt,
    })
    .pipe(
      Effect.mapError((error) =>
        error instanceof PersonaStoreRateLimited
          ? new RateLimited({
              message: "Persona creation rate limit exceeded",
              retry_after_seconds: error.retryAfterSeconds,
            })
          : error instanceof PersonaStoreConflict
            ? new Conflict({ message: "Persona creation conflicts with an existing request" })
            : new InternalError({ message: "Persona creation failed" }),
      ),
    );
});

const walletStoreFailure = (error: unknown): Conflict | InternalError =>
  error instanceof PersonaWalletStoreConflict
    ? new Conflict({ message: "Persona wallet assignment conflicts with existing state" })
    : new InternalError({ message: "Persona wallet assignment failed" });

export const preparePersonaEvmWallet = Effect.fn("preparePersonaEvmWallet")(function* (
  input: Readonly<{
    accountId: string;
    personaId: string;
    body: PreparePersonaEvmWalletBody;
  }>,
  services: PersonaWalletServices,
): Effect.fn.Return<PersonaWalletPreparation, Conflict | InternalError | NotFound> {
  const existing = yield* services.store
    .getEvmPreparation(input)
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona wallet lookup failed" })));
  if (existing === null) return yield* new NotFound({ message: "Persona not found" });
  return yield* services.store
    .reserveEvm({
      accountId: input.accountId,
      personaId: input.personaId,
      idempotencyKey: input.body.idempotency_key,
    })
    .pipe(Effect.mapError(walletStoreFailure));
});

const validAttestation = (
  attestation: EmbeddedEvmWalletAttestation,
  expectedIndex: number,
): boolean =>
  usableId(attestation.sourceUserId) &&
  (attestation.privyWalletId === null || usableId(attestation.privyWalletId)) &&
  Number.isSafeInteger(attestation.hdWalletIndex) &&
  attestation.hdWalletIndex === expectedIndex &&
  /^0x[0-9a-f]{40}$/u.test(attestation.address);

export const confirmPersonaEvmWallet = Effect.fn("confirmPersonaEvmWallet")(function* (
  input: Readonly<{
    accountId: string;
    personaId: string;
    body: ConfirmPersonaEvmWalletBody;
  }>,
  services: PersonaWalletServices,
): Effect.fn.Return<PersonaWalletAssignment, AuthError | Conflict | InternalError | NotFound> {
  const preparation = yield* services.store
    .getEvmPreparation(input)
    .pipe(Effect.mapError(() => new InternalError({ message: "Persona wallet lookup failed" })));
  if (preparation === null) {
    return yield* new Conflict({ message: "Persona wallet has not been prepared" });
  }
  if (preparation.status === "active") return preparation.assignment;

  const attestation = yield* services.verifier
    .verifyPrivyEmbeddedEvmWallet({
      accessToken: input.body.proof.privy_access_token,
      identityToken: input.body.proof.privy_identity_token ?? null,
      hdWalletIndex: preparation.hd_wallet_index,
    })
    .pipe(
      Effect.mapError((error) =>
        error.reason === "invalid"
          ? new AuthError({ message: "Wallet proof rejected" })
          : new InternalError({ message: "Wallet proof unavailable" }),
      ),
    );
  if (!validAttestation(attestation, preparation.hd_wallet_index)) {
    return yield* new AuthError({ message: "Wallet proof rejected" });
  }

  const canonicalAccountId = yield* services.accounts
    .canonicalAccountId(attestation.sourceUserId)
    .pipe(Effect.mapError(() => new InternalError({ message: "Wallet identity lookup failed" })));
  if (canonicalAccountId !== input.accountId) {
    return yield* new AuthError({ message: "Wallet proof rejected" });
  }

  return yield* services.store
    .confirmEvm({
      accountId: input.accountId,
      personaId: input.personaId,
      attestation,
    })
    .pipe(Effect.mapError(walletStoreFailure));
});

export const retirePersona = Effect.fn("retirePersona")(function* (
  input: Readonly<{
    accountId: string;
    personaId: string;
    body: RetirePersonaBody;
  }>,
  services: Pick<PersonaWalletServices, "store">,
): Effect.fn.Return<PersonaRetirementV1, AuthError | Conflict | InternalError | NotFound> {
  if (!usableId(input.accountId) || !usableId(input.personaId)) {
    return yield* new AuthError({ message: "Authentication failed" });
  }
  const result = yield* services.store
    .retire({
      accountId: input.accountId,
      personaId: input.personaId,
      idempotencyKey: input.body.idempotency_key,
      ...(input.body.replacement_persona_id === undefined
        ? {}
        : { replacementPersonaId: input.body.replacement_persona_id }),
    })
    .pipe(Effect.mapError(walletStoreFailure));
  if (result === null) return yield* new NotFound({ message: "Persona not found" });
  return result;
});
