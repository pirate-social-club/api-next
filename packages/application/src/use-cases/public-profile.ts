import { BadRequest, GetPublicProfileByHandle, InternalError, NotFound } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  type PublicProfileDocument,
  type PublicProfileLookup,
  PublicProfileRepositoryError,
  type PublicProfileStoreService,
} from "../ports.ts";

export type PublicProfileHandle = Readonly<{
  readonly stem: string;
  readonly labelDisplay: string;
}>;

/**
 * The public profile route accepts only the ASCII Pirate namespace. In
 * particular, this is not the linked-handle resolver: ENS, Unicode/IDNA,
 * control characters, and malformed suffixes are rejected as bad requests.
 */
export function normalizePirateHandle(value: string): PublicProfileHandle {
  if (
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  ) {
    throw new BadRequest({ message: "Invalid Pirate handle" });
  }
  if ([...value].some((character) => character.charCodeAt(0) > 0x7f)) {
    throw new BadRequest({ message: "Invalid Pirate handle" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BadRequest({ message: "Invalid Pirate handle" });
  }

  const lower = trimmed.toLowerCase().replace(/^@+/u, "");
  const stem = lower.endsWith(".pirate") ? lower.slice(0, -".pirate".length) : lower;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stem) || stem.length > 32) {
    throw new BadRequest({ message: "Invalid Pirate handle" });
  }
  return { stem, labelDisplay: `${stem}.pirate` };
}

type PublicProfileInput = Readonly<{ readonly handle: string }>;

export interface PublicProfileServices {
  readonly publicProfileStore: PublicProfileStoreService;
}

const publicProfileResponse = GetPublicProfileByHandle.response;

function projectionFailure(): InternalError {
  return new InternalError({ message: "Public profile lookup failed" });
}

/** Build the public response from persona-only storage. */
function projectPublicProfileDocument(lookup: PublicProfileLookup): PublicProfileDocument {
  const created = Date.parse(lookup.createdAt);
  if (!Number.isFinite(created)) throw projectionFailure();
  const profile = {
    id: lookup.personaId,
    object: "profile" as const,
    display_name: lookup.displayName,
    avatar_ref: lookup.avatarRef,
    avatar_source: null,
    cover_ref: lookup.coverRef,
    cover_source: null,
    bio: lookup.bio,
    bio_source: null,
    preferred_locale: lookup.preferredLocale,
    global_handle: {
      id: `gh_${lookup.handleId}`,
      object: "global_handle" as const,
      label: lookup.resolvedHandleLabelDisplay,
      status: "active" as const,
    },
    created: Math.floor(created / 1_000),
  };
  const document = {
    profile,
    requested_handle_label: lookup.handleLabelDisplay,
    resolved_handle_label: lookup.resolvedHandleLabelDisplay,
    is_canonical: lookup.handleStatus === "active",
    created_communities: [],
  } satisfies PublicProfileDocument;
  Schema.decodeUnknownSync(publicProfileResponse)(document);
  return document;
}

export const getPublicProfileByHandle = Effect.fn("getPublicProfileByHandle")(function* (
  input: PublicProfileInput,
  services: PublicProfileServices,
): Effect.fn.Return<PublicProfileDocument, BadRequest | NotFound | InternalError> {
  let normalized: PublicProfileHandle;
  try {
    normalized = normalizePirateHandle(input.handle);
  } catch (error) {
    return yield* error instanceof BadRequest
      ? error
      : new BadRequest({ message: "Invalid Pirate handle" });
  }

  const lookup = yield* services.publicProfileStore
    .getByHandle({ labelNormalized: normalized.stem })
    .pipe(
      Effect.mapError((error) =>
        error instanceof PublicProfileRepositoryError && error.reason === "invalid-alias"
          ? projectionFailure()
          : error instanceof PublicProfileRepositoryError
            ? projectionFailure()
            : projectionFailure(),
      ),
    );
  if (lookup === null) return yield* new NotFound({ message: "Profile not found" });

  return yield* Effect.try({
    try: () => projectPublicProfileDocument(lookup),
    catch: () => projectionFailure(),
  });
});

export const makePublicProfileHandler =
  (services: PublicProfileServices) =>
  async (input: { readonly params: unknown }): Promise<PublicProfileDocument> => {
    const params = input.params as PublicProfileInput;
    return Effect.runPromise(getPublicProfileByHandle(params, services));
  };
