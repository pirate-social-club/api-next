import {
  BadRequest,
  type GetPublicCommunityThreads,
  InternalError,
  NotFound,
} from "@pirate/contracts";
import { Effect, type Schema } from "effect";
import {
  type PublicCommunityThreadsDocument,
  type PublicCommunityThreadsQuery,
  PublicCommunityThreadsRepositoryError,
  type PublicCommunityThreadsStoreService,
} from "../../ports.ts";

export type PublicCommunityThreadsInput = Readonly<{
  readonly communityRef: string;
  readonly query: PublicCommunityThreadsQuery;
}>;

export type PublicCommunityThreadsServices = Readonly<{
  readonly publicCommunityThreadsStore: PublicCommunityThreadsStoreService;
}>;

export type PublicCommunityThreadsResponse = Schema.Schema.Type<
  typeof GetPublicCommunityThreads.response
>;

const MAX_COMMUNITY_REF_LENGTH = 512;
const MAX_SLUG_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_LOCALE_LENGTH = 64;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const validBoundedText = (value: unknown, maxLength: number): boolean =>
  value === undefined ||
  (typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasControlCharacter(value));

/**
 * Decode exactly one route candidate for the persisted canonical slug lookup.
 * The original route value remains available to the repository for the
 * exact-ID lookup, so lower-casing never changes ID precedence.
 */
export const normalizePublicCommunityRef = (value: string): string => {
  if (
    value.length === 0 ||
    value.length > MAX_COMMUNITY_REF_LENGTH ||
    hasControlCharacter(value) ||
    value.includes("\u0000")
  ) {
    throw new BadRequest({ message: "Invalid community reference" });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new BadRequest({ message: "Invalid community reference" });
  }

  const candidate = decoded.normalize("NFKC").toLowerCase();
  if (
    candidate.length === 0 ||
    candidate.length > MAX_SLUG_LENGTH ||
    candidate !== candidate.trim() ||
    hasControlCharacter(candidate) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate)
  ) {
    throw new BadRequest({ message: "Invalid community reference" });
  }
  return candidate;
};

const mapFailure = (error: unknown): BadRequest | InternalError =>
  error instanceof PublicCommunityThreadsRepositoryError &&
  (error.reason === "invalid-cursor" || error.reason === "invalid-community-ref")
    ? new BadRequest({ message: "Invalid public community threads request" })
    : new InternalError({ message: "Public community threads lookup failed" });

export const getPublicCommunityThreads = Effect.fn("getPublicCommunityThreads")(function* (
  input: PublicCommunityThreadsInput,
  services: PublicCommunityThreadsServices,
): Effect.fn.Return<PublicCommunityThreadsDocument, BadRequest | InternalError | NotFound> {
  if (typeof input.query !== "object" || input.query === null) {
    return yield* new BadRequest({ message: "Invalid public community threads request" });
  }
  const queryRecord = input.query as Record<string, unknown>;
  const unsupportedQueryMember = Object.keys(queryRecord).some(
    (key) => !["surface", "sort", "cursor", "locale"].includes(key),
  );
  if (
    typeof input.communityRef !== "string" ||
    input.communityRef.length === 0 ||
    input.communityRef.length > MAX_COMMUNITY_REF_LENGTH ||
    hasControlCharacter(input.communityRef) ||
    input.query.surface !== "threads" ||
    input.query.sort !== "new" ||
    unsupportedQueryMember ||
    !validBoundedText(input.query.cursor, MAX_CURSOR_LENGTH) ||
    !validBoundedText(input.query.locale, MAX_LOCALE_LENGTH)
  ) {
    return yield* new BadRequest({ message: "Invalid public community threads request" });
  }

  let slugCandidate: string;
  try {
    slugCandidate = normalizePublicCommunityRef(input.communityRef);
  } catch (error) {
    return yield* error instanceof BadRequest
      ? error
      : new BadRequest({ message: "Invalid community reference" });
  }

  const result = yield* services.publicCommunityThreadsStore
    .listPublicCommunityThreads({
      communityRef: input.communityRef,
      slugCandidate,
      query: input.query,
    })
    .pipe(Effect.mapError(mapFailure));

  if (result === null) return yield* new NotFound({ message: "Community not found" });
  return result;
});
