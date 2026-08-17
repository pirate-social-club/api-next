import { BadRequest, GetPublicProfileByHandle, InternalError, NotFound } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import {
  type PublicProfileDocument,
  type PublicProfileLookup,
  PublicProfileRepositoryError,
  type PublicProfileStoreService,
} from "../ports.ts";
import { projectIdentityAccount } from "./identity-account.ts";

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

/** Build the dedicated public response from the existing validated account projection. */
function projectPublicProfileDocument(lookup: PublicProfileLookup): PublicProfileDocument {
  const projected = projectIdentityAccount({
    userId: lookup.canonicalUserId,
    account: lookup.account,
  });
  const globalHandle = projected.profile.global_handle;
  if (
    globalHandle.status !== "active" ||
    globalHandle.id !== `gh_${lookup.handleId}` ||
    normalizePirateHandle(globalHandle.label).stem !== lookup.handleLabelNormalized
  ) {
    throw projectionFailure();
  }

  const profile = {
    id: projected.profile.id,
    object: "profile" as const,
    display_name: projected.profile.display_name ?? null,
    avatar_ref: projected.profile.avatar_ref ?? null,
    avatar_source: projected.profile.avatar_source ?? null,
    cover_ref: projected.profile.cover_ref ?? null,
    cover_source: projected.profile.cover_source ?? null,
    bio: projected.profile.bio ?? null,
    bio_source: projected.profile.bio_source ?? null,
    preferred_locale: projected.profile.preferred_locale ?? null,
    global_handle: {
      id: globalHandle.id,
      object: "global_handle" as const,
      label: globalHandle.label,
      status: globalHandle.status,
    },
    created: projected.profile.created,
  };
  const document = {
    profile,
    requested_handle_label: lookup.handleLabelDisplay,
    resolved_handle_label: globalHandle.label,
    is_canonical: lookup.handleStatus === "active",
    created_communities: [...lookup.createdCommunities],
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
