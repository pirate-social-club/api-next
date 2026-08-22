import { Data, Effect, Option, Schema } from "effect";

const exactParseOptions = { onExcessProperty: "error" } as const;

const BoundedPrincipalId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value &&
    !value.includes("\u0000") &&
    new TextEncoder().encode(value).byteLength <= 256
      ? undefined
      : "Expected a bounded system principal identifier",
  ),
);

const BatchLimit = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 100
      ? undefined
      : "Expected a batch limit from 1 through 100",
  ),
);

export const CommunityRouteExpiryInput = Schema.Struct({
  family: Schema.Literals(["hns", "spaces"]),
  limit: BatchLimit,
  principal_id: BoundedPrincipalId,
});
export type CommunityRouteExpiryInput = Schema.Schema.Type<typeof CommunityRouteExpiryInput>;

export type CommunityRouteExpiryBatchSummary = Readonly<{
  readonly selected: number;
  readonly transitioned: number;
  readonly stale: number;
}>;

export class CommunityRouteExpiryRejected extends Data.TaggedError("CommunityRouteExpiryRejected")<{
  readonly reason: "invalid";
}> {}

export class CommunityRouteExpiryStorageFailed extends Data.TaggedError(
  "CommunityRouteExpiryStorageFailed",
) {}

export interface CommunityRouteExpiryStore {
  readonly expire: (
    input: CommunityRouteExpiryInput,
  ) => Effect.Effect<CommunityRouteExpiryBatchSummary, CommunityRouteExpiryStorageFailed>;
}

export type CommunityRouteExpiryServices = Readonly<{
  readonly store: CommunityRouteExpiryStore;
}>;

/**
 * Runs the provider-independent database-time lifecycle transition through an
 * injected authority store. The application validates scheduler policy input;
 * the store owns database-clock, lock-order, compare-and-set, and audit atomicity.
 */
export function expireCommunityRouteEvidence(
  input: unknown,
  services: CommunityRouteExpiryServices,
): Effect.Effect<
  CommunityRouteExpiryBatchSummary,
  CommunityRouteExpiryRejected | CommunityRouteExpiryStorageFailed
> {
  const decoded = Schema.decodeUnknownOption(CommunityRouteExpiryInput, exactParseOptions)(input);
  if (Option.isNone(decoded)) {
    return Effect.fail(new CommunityRouteExpiryRejected({ reason: "invalid" }));
  }
  return services.store.expire(decoded.value);
}
