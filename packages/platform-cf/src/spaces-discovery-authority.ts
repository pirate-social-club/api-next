import { Effect, Schema } from "effect";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";

type SpacesDiscoveryRoot = Readonly<{ network: string; canonicalRoot: string }>;
export type SpacesDiscoveryObservation =
  | Readonly<{ kind: "temporarily_unavailable" }>
  | Readonly<{
      kind: "verified";
      network: string;
      canonicalRoot: string;
      rootKey: string;
      outpoint: string;
      operatorNumLive: boolean;
      reverseDelegationMatches: boolean;
      delegationScript: string | null;
      commitmentCount: number;
      latestRoot: string | null;
    }>;
export type SpacesDiscoveryAuthority =
  | ((root: SpacesDiscoveryRoot) => Effect.Effect<SpacesDiscoveryObservation, unknown>)
  | null;
export type SpacesDiscoveryBinding = SpacesDiscoveryRoot &
  Readonly<{
    rootKey: string;
    outpoint: string;
    delegationAddress: string;
    commitmentCount: number | null;
    latestRoot: string | null;
  }>;

const unavailable = { kind: "temporarily_unavailable" } as const;
const LatestCommitment = Schema.Struct({
  state_root: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

/** A pending or foreign response cannot establish loss of the requested root. */
export function makeSpacesDiscoveryAuthority(
  observer: SpacesRootAuthorityObserver,
): NonNullable<SpacesDiscoveryAuthority> {
  return Effect.fn("makeSpacesDiscoveryAuthority.observe")(
    function* (root: SpacesDiscoveryRoot): Effect.fn.Return<SpacesDiscoveryObservation, unknown> {
      if (root.network !== "mainnet") return unavailable;
      const result = yield* Effect.tryPromise((signal) =>
        observer.observe({ canonicalRoot: root.canonicalRoot }, signal),
      );
      if (result.kind !== "verified") return unavailable;
      const evidence = result.evidence;
      if (evidence.network !== root.network || evidence.root !== `@${root.canonicalRoot}`)
        return unavailable;
      const latestRoot =
        evidence.commitment_count === 0
          ? null
          : yield* Effect.try(
              () =>
                Schema.decodeUnknownSync(LatestCommitment)(evidence.latest_commitment).state_root,
            );
      return {
        kind: "verified",
        ...root,
        rootKey: evidence.owner_xonly_key_hex,
        outpoint: evidence.outpoint,
        operatorNumLive: evidence.operator_num_live,
        reverseDelegationMatches: evidence.reverse_delegation_matches,
        delegationScript: evidence.operator_num_holder_script_pubkey_hex,
        commitmentCount: evidence.commitment_count,
        latestRoot,
      };
    },
    Effect.catch(() => Effect.succeed(unavailable)),
  );
}

/** Transaction readiness failure is distinct from verified ownership loss. */
export function assessSpacesDiscoveryAuthority(
  binding: SpacesDiscoveryBinding,
  observation: SpacesDiscoveryObservation,
): "available" | "temporarily_unavailable" | "verified_ownership_loss" {
  if (
    observation.kind !== "verified" ||
    observation.network !== binding.network ||
    observation.canonicalRoot !== binding.canonicalRoot
  )
    return "temporarily_unavailable";
  if (observation.rootKey !== binding.rootKey || observation.outpoint !== binding.outpoint)
    return "verified_ownership_loss";
  return observation.operatorNumLive &&
    observation.reverseDelegationMatches &&
    observation.delegationScript === spacesDelegationScriptV1(binding.delegationAddress) &&
    observation.commitmentCount === binding.commitmentCount &&
    observation.latestRoot === binding.latestRoot
    ? "available"
    : "temporarily_unavailable";
}

export const spacesDiscoveryRootKey = (root: SpacesDiscoveryRoot): string =>
  JSON.stringify([root.network, root.canonicalRoot]);

/** Reuse observations only within one page, under one three-root deadline. */
export const observeSpacesDiscoveryRoots = Effect.fn("observeSpacesDiscoveryRoots")(function* (
  authority: SpacesDiscoveryAuthority,
  roots: readonly SpacesDiscoveryRoot[],
) {
  const observations = new Map<string, SpacesDiscoveryObservation>();
  if (authority === null) return observations;
  const unique = new Map(roots.map((root) => [spacesDiscoveryRootKey(root), root]));
  yield* Effect.forEach(
    Array.from(unique.entries()).slice(0, 3),
    ([key, root]) =>
      authority(root).pipe(
        Effect.catch(() => Effect.succeed(unavailable)),
        Effect.flatMap((observation) => Effect.sync(() => observations.set(key, observation))),
      ),
    { concurrency: 3 },
  ).pipe(Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed([]) }));
  return observations;
});
