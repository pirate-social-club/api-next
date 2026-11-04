import {
  isCanonicalSpacesRootV1,
  type SpacesNetworkV1,
  type SpacesUpstreamAckOutcomeV1,
} from "@pirate/domain";
import { Effect, Option, Schema } from "effect";
import type { HandleSalesStorageFailed } from "./sales.ts";

/**
 * The private Spaces registry contract (spec 012 §5.3.13.5), hosting the
 * four endpoints the upstream operator (`subs` 4dcc923, `REGISTRY.md`) polls:
 * `/health`, `/pending`, `/ack`, and `/committed`. The operator initiates all
 * traffic; api-next never calls it. Nothing here creates a grant: an
 * acknowledgment or commit notification only settles registry work, fails a
 * claim that can never be fulfilled, or makes a claim due for independent
 * verification. The store is composed only when the registry is explicitly
 * enabled, and no public contract or generated client names it.
 */

export type SpacesRegistryEnvironmentV1 = "development" | "staging" | "production";

/** An authenticated operator credential: one operator instance, one environment. */
export type SpacesRegistryCredentialV1 = Readonly<{
  credential_id: string;
  operator_instance_id: string;
  network: SpacesNetworkV1;
  allowed_roots: readonly string[];
}>;

/**
 * The percent-decoded `space` query value. Only `@<canonical_root>` can name
 * a Pirate activation; numeric spaces (`#…`) never match one.
 */
export type SpacesRegistrySpaceV1 =
  | Readonly<{ kind: "root"; canonical_root: string }>
  | Readonly<{ kind: "numeric"; raw: string }>
  | Readonly<{ kind: "invalid"; raw: string }>;

export type SpacesRegistryPendingHandleV1 = Readonly<{ handle: string; script_pubkey: string }>;

export type SpacesRegistryPendingResultV1 =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "handles"; handles: readonly SpacesRegistryPendingHandleV1[] }>;

/** One `/ack` entry. A malformed entry is recorded as an anomaly, never applied. */
export type SpacesRegistryAckEntryV1 =
  | Readonly<{ kind: "outcome"; handle: string; outcome: SpacesUpstreamAckOutcomeV1 }>
  | Readonly<{ kind: "malformed"; raw: string }>;

/**
 * What happened to one entry: applied durably, an idempotent repeat, fenced
 * as a stale operator-assignment generation, or recorded as a scope anomaly.
 */
export type SpacesRegistryEntryDispositionV1 = "applied" | "unchanged" | "stale" | "anomaly";

export type SpacesRegistryStopResultV1 = Readonly<{
  kind: "withdrawn" | "redelivery_stopped" | "unchanged" | "not_found";
}>;

export interface SpacesRegistryStore {
  /** Constant-time verification of a presented bearer token; null is `401`. */
  readonly authenticate: (
    input: Readonly<{ token: string; environment: SpacesRegistryEnvironmentV1 }>,
  ) => Effect.Effect<SpacesRegistryCredentialV1 | null, HandleSalesStorageFailed>;
  /**
   * One page for exactly one space, oldest first, with each delivery recorded
   * in the selecting transaction. An unassigned space is recorded as a scope
   * anomaly and forbidden; an assigned space that is not active and ready
   * yields no handles.
   */
  readonly pending: (
    input: Readonly<{
      credential: SpacesRegistryCredentialV1;
      space: SpacesRegistrySpaceV1;
      capacity: number;
    }>,
  ) => Effect.Effect<SpacesRegistryPendingResultV1, HandleSalesStorageFailed>;
  /** Applies one entry durably in its own transaction. */
  readonly acknowledge: (
    input: Readonly<{ credential: SpacesRegistryCredentialV1; entry: SpacesRegistryAckEntryV1 }>,
  ) => Effect.Effect<SpacesRegistryEntryDispositionV1, HandleSalesStorageFailed>;
  /** Records the hint, then makes each matching claim due for verification. */
  readonly committed: (
    input: Readonly<{
      credential: SpacesRegistryCredentialV1;
      commitment_root_hex: string;
      handles: readonly string[];
    }>,
  ) => Effect.Effect<readonly SpacesRegistryEntryDispositionV1[], HandleSalesStorageFailed>;
  /**
   * The platform stop of §5.3.13.8. Before any delivery it withdraws the item
   * and fails the claim, releasing the fence and the cap reservation; after a
   * possible delivery it only stops redelivery and keeps both.
   */
  readonly stopClaim: (
    input: Readonly<{ claimId: string }>,
  ) => Effect.Effect<SpacesRegistryStopResultV1, HandleSalesStorageFailed>;
}

/** A page must answer within the upstream client's 10-second request timeout. */
export const SPACES_REGISTRY_MAX_PAGE_CAPACITY = 500;
const MAX_ACK_ENTRIES = 1_000;
const MAX_COMMITTED_HANDLES = 10_000;

export function decodeSpacesRegistrySpaceV1(raw: string): SpacesRegistrySpaceV1 {
  if (raw.startsWith("#")) return { kind: "numeric", raw };
  const root = raw.startsWith("@") ? raw.slice(1) : null;
  return root !== null && isCanonicalSpacesRootV1(root)
    ? { kind: "root", canonical_root: root }
    : { kind: "invalid", raw };
}

const AckOutcome = Schema.Literals([
  "staged",
  "already_staged_same_spk",
  "already_committed_same_spk",
  "already_staged_different_spk",
  "already_committed_different_spk",
  "invalid",
]);
const AckEntry = Schema.Struct({ handle: Schema.String, outcome: AckOutcome });
const AckBody = Schema.Struct({
  handles: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(MAX_ACK_ENTRIES)),
});
const CommittedBody = Schema.Struct({
  root: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  handles: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_COMMITTED_HANDLES)),
});

const rawEntry = (entry: unknown): string => {
  try {
    return JSON.stringify(entry) ?? "undefined";
  } catch {
    return "unserializable";
  }
};

type InvalidRequest = Readonly<{ kind: "invalid_request" }>;
const INVALID_REQUEST: InvalidRequest = { kind: "invalid_request" };

type SpacesRegistryEntrySummaryV1 = Readonly<Record<SpacesRegistryEntryDispositionV1, number>>;

const summarize = (
  dispositions: readonly SpacesRegistryEntryDispositionV1[],
): SpacesRegistryEntrySummaryV1 => {
  const summary = { applied: 0, unchanged: 0, stale: 0, anomaly: 0 };
  for (const disposition of dispositions) summary[disposition] += 1;
  return summary;
};

export type SpacesRegistryService = ReturnType<typeof makeSpacesRegistryService>;

/**
 * The registry use cases. Authentication precedes every body decode, entries
 * are applied one at a time so each lock is short and every entry is durable
 * before the next, and a response reports success only after all of them.
 */
export function makeSpacesRegistryService(input: {
  readonly store: SpacesRegistryStore;
  readonly environment: SpacesRegistryEnvironmentV1;
  readonly pageCapacity: number;
}) {
  if (
    !Number.isSafeInteger(input.pageCapacity) ||
    input.pageCapacity < 1 ||
    input.pageCapacity > SPACES_REGISTRY_MAX_PAGE_CAPACITY
  ) {
    throw new RangeError("Spaces registry page capacity is out of bounds");
  }
  const { store } = input;
  return {
    authenticate: (token: string) => store.authenticate({ token, environment: input.environment }),

    /** `space` must appear exactly once; its value is already percent-decoded. */
    pending: Effect.fn("SpacesRegistry.pending")(function* (
      credential: SpacesRegistryCredentialV1,
      spaces: readonly string[],
    ) {
      const [space] = spaces;
      if (spaces.length !== 1 || space === undefined) return INVALID_REQUEST;
      return yield* store.pending({
        credential,
        space: decodeSpacesRegistrySpaceV1(space),
        capacity: input.pageCapacity,
      });
    }),

    acknowledge: Effect.fn("SpacesRegistry.acknowledge")(function* (
      credential: SpacesRegistryCredentialV1,
      body: unknown,
    ) {
      const decoded = Schema.decodeUnknownOption(AckBody)(body);
      if (Option.isNone(decoded)) return INVALID_REQUEST;
      const entries = decoded.value.handles.map((entry): SpacesRegistryAckEntryV1 => {
        const parsed = Schema.decodeUnknownOption(AckEntry)(entry);
        return Option.isSome(parsed)
          ? { kind: "outcome", handle: parsed.value.handle, outcome: parsed.value.outcome }
          : { kind: "malformed", raw: rawEntry(entry) };
      });
      const dispositions = yield* Effect.forEach(
        entries,
        (entry) => store.acknowledge({ credential, entry }),
        { concurrency: 1 },
      );
      return { kind: "applied" as const, summary: summarize(dispositions) };
    }),

    committed: Effect.fn("SpacesRegistry.committed")(function* (
      credential: SpacesRegistryCredentialV1,
      body: unknown,
    ) {
      const decoded = Schema.decodeUnknownOption(CommittedBody)(body);
      if (Option.isNone(decoded)) return INVALID_REQUEST;
      const dispositions = yield* store.committed({
        credential,
        commitment_root_hex: decoded.value.root,
        handles: decoded.value.handles,
      });
      return { kind: "applied" as const, summary: summarize(dispositions) };
    }),
  };
}
