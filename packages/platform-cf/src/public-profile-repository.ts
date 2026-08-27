import {
  ControlPlaneDb,
  type ControlPlaneError,
  type IdentityStore,
  type PublicProfileLookup,
  PublicProfileRepositoryError,
  type PublicProfileRepositoryFailure,
  type PublicProfileStoreService,
} from "@pirate/application";
import { Effect, type Layer } from "effect";

type HandleRow = Readonly<{
  handle_id: unknown;
  platform_handle_id: unknown;
  label_normalized: unknown;
  label_display: unknown;
  status: unknown;
  owner_user_id: unknown;
  owner_persona_id: unknown;
  redirect_target_handle_id: unknown;
}>;

type PersonaProfileRow = Readonly<{
  persona_id: unknown;
  display_name: unknown;
  avatar_ref: unknown;
  cover_ref: unknown;
  bio: unknown;
  preferred_locale: unknown;
  created_at: unknown;
}>;

type ParsedHandle = Readonly<{
  physicalHandleId: string;
  platformHandleId: string;
  labelNormalized: string;
  labelDisplay: string;
  status: "active" | "redirect";
  ownerPersonaId: string;
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
    !validId(row.platform_handle_id) ||
    !validId(row.label_normalized) ||
    !validId(row.label_display) ||
    !validId(row.owner_persona_id) ||
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
    physicalHandleId: row.handle_id,
    platformHandleId: row.platform_handle_id,
    labelNormalized: row.label_normalized,
    labelDisplay: row.label_display,
    status: row.status,
    ownerPersonaId: row.owner_persona_id,
    redirectTargetHandleId: targetId,
  };
};

const invalidAlias = () => new PublicProfileRepositoryError({ reason: "invalid-alias" });

interface PublicProfileRepository {
  readonly getByHandle: (
    input: Parameters<PublicProfileStoreService["getByHandle"]>[0],
  ) => Effect.Effect<PublicProfileLookup | null, PublicProfileRepositoryFailure, ControlPlaneDb>;
}

export function makeControlPlanePublicProfileRepository(
  _identityStore: IdentityStore["Service"],
): PublicProfileRepository {
  const getByHandle: PublicProfileRepository["getByHandle"] = ({ labelNormalized }) =>
    Effect.gen(function* () {
      if (!validId(labelNormalized)) return null;
      const db = yield* ControlPlaneDb;
      const handleResult = yield* db.execute<HandleRow>({
        label: "public-profiles.handles.lookup",
        text: `SELECT handle_id, platform_handle_id, label_normalized, label_display, status,
                      owner_user_id, owner_persona_id, redirect_target_handle_id
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
          text: `SELECT handle_id, platform_handle_id, label_normalized, label_display, status,
                        owner_user_id, owner_persona_id, redirect_target_handle_id
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
          target.physicalHandleId === requestedHandle.physicalHandleId ||
          target.ownerPersonaId !== requestedHandle.ownerPersonaId ||
          target.platformHandleId !== requestedHandle.platformHandleId
        ) {
          return null;
        }
        resolvedHandle = target;
      }

      const profileResult = yield* db.execute<PersonaProfileRow>({
        label: "public-profiles.personas.profile",
        text: `SELECT persona.persona_id, profile.display_name, profile.avatar_ref,
                      profile.cover_ref, profile.bio, profile.preferred_locale,
                      persona.created_at
          FROM personas AS persona
          JOIN users AS account
            ON account.user_id = persona.account_id
           AND account.status = 'active'
          JOIN persona_profiles AS profile
                   ON profile.persona_id = persona.persona_id
                WHERE persona.persona_id = $1`,
        values: [resolvedHandle.ownerPersonaId],
        readonly: true,
      });
      if (profileResult.rows.length !== 1 || profileResult.rows[0] === undefined) return null;
      const profile = profileResult.rows[0];
      const nullable = (value: unknown): string | null | undefined =>
        value === null ? null : typeof value === "string" ? value : undefined;
      const displayName = nullable(profile.display_name);
      const avatarRef = nullable(profile.avatar_ref);
      const coverRef = nullable(profile.cover_ref);
      const bio = nullable(profile.bio);
      const preferredLocale = nullable(profile.preferred_locale);
      const createdAt =
        profile.created_at instanceof Date
          ? profile.created_at.toISOString()
          : typeof profile.created_at === "string"
            ? profile.created_at
            : null;
      if (
        !validId(profile.persona_id) ||
        displayName === undefined ||
        avatarRef === undefined ||
        coverRef === undefined ||
        bio === undefined ||
        preferredLocale === undefined ||
        createdAt === null ||
        !Number.isFinite(Date.parse(createdAt))
      ) {
        return yield* Effect.fail(invalidAlias());
      }

      return {
        personaId: profile.persona_id,
        displayName,
        avatarRef,
        coverRef,
        bio,
        preferredLocale,
        createdAt,
        handleId: resolvedHandle.platformHandleId,
        resolvedHandleLabelDisplay: resolvedHandle.labelDisplay,
        handleLabelNormalized: resolvedHandle.labelNormalized,
        handleLabelDisplay: requestedHandle.labelNormalized.endsWith(".pirate")
          ? requestedHandle.labelNormalized
          : `${requestedHandle.labelNormalized}.pirate`,
        handleStatus: requestedHandle.status,
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
