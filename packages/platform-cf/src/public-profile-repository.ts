import {
  ControlPlaneDb,
  type ControlPlaneError,
  IdentityResolutionError,
  type IdentityStore,
  type PublicProfileLookup,
  PublicProfileRepositoryError,
  type PublicProfileRepositoryFailure,
  type PublicProfileStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type HandleRow = Readonly<{
  handle_id: unknown;
  label_normalized: unknown;
  label_display: unknown;
  status: unknown;
  owner_user_id: unknown;
  redirect_target_handle_id: unknown;
}>;

type CommunityRow = Readonly<{
  community_id: unknown;
  display_name: unknown;
  created_at: unknown;
  route_slug: unknown;
}>;

type ParsedHandle = Readonly<{
  handleId: string;
  labelNormalized: string;
  labelDisplay: string;
  status: "active" | "redirect";
  ownerUserId: string;
  redirectTargetHandleId: string | null;
}>;

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !value.includes("\u0000");

const parseHandle = (row: HandleRow): ParsedHandle | null => {
  if (
    !validId(row.handle_id) ||
    !validId(row.label_normalized) ||
    !validId(row.label_display) ||
    !validId(row.owner_user_id) ||
    (row.status !== "active" && row.status !== "redirect")
  ) {
    return null;
  }
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.label_normalized) ||
    row.label_normalized.length > 32 ||
    row.label_display !== `${row.label_normalized}.pirate`
  ) {
    return null;
  }
  const target = row.redirect_target_handle_id ?? null;
  if (row.status === "active" && target !== null) return null;
  if (row.status === "redirect" && !validId(target)) return null;
  const targetId = target === null ? null : validId(target) ? target : null;
  return {
    handleId: row.handle_id,
    labelNormalized: row.label_normalized,
    labelDisplay: row.label_display,
    status: row.status,
    ownerUserId: row.owner_user_id,
    redirectTargetHandleId: targetId,
  };
};

const asTimestamp = (value: unknown): number | null => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = Math.abs(value) >= 100_000_000_000 ? value / 1_000 : value;
    return Number.isSafeInteger(Math.floor(seconds)) ? Math.floor(seconds) : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
  }
  return null;
};

const invalidAlias = () => new PublicProfileRepositoryError({ reason: "invalid-alias" });

function resolveOwner(
  identityStore: IdentityStore["Service"],
  sourceUserId: string,
): Effect.Effect<
  { readonly canonicalUserId: string } | null,
  PublicProfileRepositoryError | ControlPlaneError
> {
  return identityStore.resolveCanonical({ sourceUserId }).pipe(
    Effect.catchIf(
      (error): error is IdentityResolutionError =>
        error instanceof IdentityResolutionError &&
        (error.reason === "missing" || error.reason === "deleted"),
      () => Effect.succeed(null),
      (error) =>
        Effect.fail(
          error instanceof IdentityResolutionError ? invalidAlias() : (error as ControlPlaneError),
        ),
    ),
    Effect.map((resolved) =>
      resolved === null ? null : { canonicalUserId: resolved.canonicalUserId },
    ),
  );
}

interface PublicProfileRepository {
  readonly getByHandle: (
    input: Parameters<PublicProfileStoreService["getByHandle"]>[0],
  ) => Effect.Effect<PublicProfileLookup | null, PublicProfileRepositoryFailure, ControlPlaneDb>;
}

export function makeControlPlanePublicProfileRepository(
  identityStore: IdentityStore["Service"],
): PublicProfileRepository {
  const getByHandle: PublicProfileRepository["getByHandle"] = ({ labelNormalized }) =>
    Effect.gen(function* () {
      if (!validId(labelNormalized)) return null;
      const db = yield* ControlPlaneDb;
      const handleResult = yield* db.execute<HandleRow>({
        label: "public-profiles.handles.lookup",
        text: `SELECT handle_id, label_normalized, label_display, status,
                      owner_user_id, redirect_target_handle_id
                 FROM public_handle_index
                WHERE label_normalized = $1
                LIMIT 1`,
        values: [labelNormalized],
        readonly: true,
      });
      if (handleResult.rows.length > 1) return yield* Effect.fail(invalidAlias());
      const requested = handleResult.rows[0];
      if (requested === undefined) return null;
      const requestedHandle = parseHandle(requested);
      if (requestedHandle === null) return null;

      let resolvedHandle = requestedHandle;
      if (requestedHandle.status === "redirect") {
        const targetResult = yield* db.execute<HandleRow>({
          label: "public-profiles.handles.redirect-target",
          text: `SELECT handle_id, label_normalized, label_display, status,
                        owner_user_id, redirect_target_handle_id
                   FROM public_handle_index
                  WHERE handle_id = $1
                  LIMIT 1`,
          values: [requestedHandle.redirectTargetHandleId],
          readonly: true,
        });
        if (targetResult.rows.length !== 1 || targetResult.rows[0] === undefined) return null;
        const target = parseHandle(targetResult.rows[0]);
        // Redirects resolve exactly one hop to a current active label. The
        // current writer turns every rename into old -> new, so arbitrary
        // chains are not needed by the public read path.
        if (
          target === null ||
          target.status !== "active" ||
          target.redirectTargetHandleId !== null ||
          target.handleId === requestedHandle.handleId
        ) {
          return null;
        }
        resolvedHandle = target;
      }

      const sourceOwner = yield* resolveOwner(identityStore, requestedHandle.ownerUserId);
      if (sourceOwner === null) return null;
      const resolvedOwner = yield* resolveOwner(identityStore, resolvedHandle.ownerUserId);
      if (resolvedOwner === null || resolvedOwner.canonicalUserId !== sourceOwner.canonicalUserId) {
        return null;
      }
      const canonical = yield* identityStore.findUser(resolvedOwner.canonicalUserId);
      if (canonical === null) return null;

      const communitiesResult = yield* db.execute<CommunityRow>({
        label: "public-profiles.communities.by-creator",
        text: `SELECT community_id, display_name, created_at, NULL::text AS route_slug
                 FROM communities
                WHERE created_by_user_id = $1
                  AND status = 'active'
                ORDER BY created_at DESC, community_id ASC`,
        values: [resolvedOwner.canonicalUserId],
        readonly: true,
      });
      const createdCommunities = communitiesResult.rows.map((row) => {
        const created = asTimestamp(row.created_at);
        if (
          !validId(row.community_id) ||
          typeof row.display_name !== "string" ||
          created === null
        ) {
          throw invalidAlias();
        }
        if (row.route_slug !== null && typeof row.route_slug !== "string") throw invalidAlias();
        return {
          community: row.community_id,
          display_name: row.display_name,
          route_slug: row.route_slug,
          created,
        };
      });

      return {
        account: canonical.account,
        canonicalUserId: canonical.userId,
        handleId: resolvedHandle.handleId,
        handleLabelNormalized: resolvedHandle.labelNormalized,
        handleLabelDisplay: requestedHandle.labelNormalized.endsWith(".pirate")
          ? requestedHandle.labelNormalized
          : `${requestedHandle.labelNormalized}.pirate`,
        handleStatus: requestedHandle.status,
        createdCommunities,
      } satisfies PublicProfileLookup;
    });

  return { getByHandle };
}

export function makeControlPlanePublicProfileStore(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError, never>,
  identityStore: IdentityStore["Service"],
): PublicProfileStoreService {
  const repository = makeControlPlanePublicProfileRepository(identityStore);
  return {
    getByHandle: (input) => Effect.provide(runtime)(repository.getByHandle(input)),
  };
}
