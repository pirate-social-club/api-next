import { Clock, Effect, Layer } from "effect";
import { HnsObserver, AdmissionError } from "./service.ts";
import { makeRpc, HsdUnavailable, type RpcConfig } from "./hsd-rpc.ts";
import {
  makeSnapshotReader,
  type Snapshot,
  type ChainConfig,
} from "./hsd-snapshot.ts";
import { agree, type Observation } from "./observation.ts";
import { inspectRecords, RecordConflict } from "./records.ts";
export interface ObserverConfig extends ChainConfig {
  nodes: readonly [RpcConfig, RpcConfig];
}
const equal = (a: Snapshot, b: Snapshot) =>
  [
    "active",
    "tipHash",
    "tipHeight",
    "tipTime",
    "safeHeight",
    "safeRoot",
    "resourceDigest",
    "ownershipEpoch",
    "safeResourceDigest",
    "safeOwnershipEpoch",
    "inclusionHash",
    "inclusionHeight",
    "inclusionTime",
    "transferPending",
  ].every((k) => a[k as keyof Snapshot] === b[k as keyof Snapshot]);
export function observerLayer(
  config: ObserverConfig,
  fetcher: typeof fetch = fetch,
) {
  if (new URL(config.nodes[0].url).href === new URL(config.nodes[1].url).href)
    throw new Error("distinct_observers_required");
  return Layer.effect(
    HnsObserver,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const now = () => Math.floor(clock.currentTimeMillisUnsafe() / 1000);
      const readers = config.nodes.map((c) =>
        makeSnapshotReader(makeRpc(c, fetcher), config, now),
      );
      const pair = (tld: string) =>
        Effect.tryPromise({
          try: (signal) =>
            Promise.all(
              readers.map((read) =>
                read(
                  tld,
                  AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                ),
              ),
            ),
          catch: (e) =>
            new AdmissionError({
              reason: e instanceof HsdUnavailable ? e.reason : "observer_stale",
            }),
        }).pipe(
          Effect.flatMap(([a, b]) => {
            if (!equal(a, b))
              return Effect.fail(
                new AdmissionError({ reason: "observer_disagreement" }),
              );
            // Freshness and stable ownership are prerequisites for any authority
            // decision, including absence. Old or provisional absence is not revocation.
            if (now() - a.tipTime > 21600 || a.tipTime > now() + 120)
              return Effect.fail(
                new AdmissionError({ reason: "chain_freshness_unconfirmed" }),
              );
            if (a.ownershipEpoch !== a.safeOwnershipEpoch)
              return Effect.fail(
                new AdmissionError({ reason: "observer_stale" }),
              );
            return Effect.succeed(a);
          }),
        );
      return HnsObserver.of({
        baseline: (binding) =>
          Effect.gen(function* () {
            if (binding.network !== config.network)
              return yield* new AdmissionError({ reason: "binding_mismatch" });
            const snapshot = yield* pair(binding.tld);
            if (!snapshot.active)
              return yield* new AdmissionError({
                reason: "namespace_not_owned",
              });
            if (snapshot.transferPending)
              return yield* new AdmissionError({ reason: "transfer_pending" });
            return {
              records: snapshot.records,
              ownershipEpoch: snapshot.ownershipEpoch,
            };
          }),
        observe: (state) =>
          Effect.gen(function* () {
            const snapshot = yield* pair(state.binding.tld);
            if (!snapshot.active)
              return {
                status: "denied" as const,
                reason: "ownership_changed" as const,
              };
            const selected = yield* Effect.try({
              try: () => inspectRecords(snapshot.records, state.binding),
              catch: (e) =>
                e instanceof RecordConflict
                  ? new AdmissionError({ reason: e.reason, detail: e.detail })
                  : new AdmissionError({
                      reason: "delegation_conflict",
                      detail: "malformed_record",
                    }),
            });
            const { active, records, ...fields } = snapshot;
            const o: Observation = {
              ...fields,
              network: config.network,
              genesis: config.genesis.startsWith("0x")
                ? config.genesis
                : "0x" + config.genesis,
              canonical: true,
              expired: false,
              delegation: selected.routing ? (selected.delegation ?? "") : "",
              challenge: selected.challenge ?? "",
            };
            const { chainId, registry, controller, communityId } =
              state.binding;
            return agree(o, o, now(), {
              network: config.network,
              genesis: o.genesis,
              chainId,
              registry,
              controller,
              communityId,
              resourceDigest: state.resourceDigest,
              challenge: state.challenge,
              ownershipEpoch: state.ownershipEpoch ?? undefined,
            });
          }),
      });
    }),
  );
}
