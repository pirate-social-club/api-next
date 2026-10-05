import type { ControlPlaneTransaction } from "@pirate/application";
import type { CommunityHandleOfferingV4 } from "@pirate/contracts";
import { Effect, Schema } from "effect";
import { integer, type Row, reject, text } from "./handle-sales-internals.ts";
import { spacesDelegationScriptV1 } from "./spaces-operator-assignment-repository.ts";
import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";

type AuthorityBinding = Target &
  Readonly<{
    network: string;
    rootKey: string;
    outpoint: string;
    delegationAddress: string;
    commitmentCount: number;
    latestRoot: string | null;
    authorityReference: string;
    authorityGeneration: number;
    assignmentId: string;
    assignmentGeneration: number;
  }>;
export type SpacesCurrentAuthority =
  | ((binding: AuthorityBinding) => Effect.Effect<boolean, unknown>)
  | null;
type Reader = Pick<ControlPlaneTransaction, "execute">;
type Target = Readonly<{
  activationId: string;
  activationGeneration: number;
  canonicalRoot: string;
}>;
const LatestCommitment = Schema.Struct({
  state_root: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});

// The supervised staging observer supports three roots. The batch has one
// deadline, so the page size cannot multiply the external request budget.
const MAX_ROOTS = 3;
const DEADLINE = "3 seconds";

const currentBinding = (db: Reader, target: Target) =>
  db.execute<Row>({
    label: "spaces-current-authority.binding.read",
    text: `SELECT activation.spaces_network,authority.root_key_hex,authority.root_outpoint,
                  authority.namespace_authority_reference,authority.namespace_authority_generation,
                  assignment.operator_assignment_id,assignment.current_generation,
                  assignment.delegation_address,
                  observation.commitment_count,observation.latest_commitment_root_hex
             FROM effective_community_handle_sale_namespace_v1(
               $1,clock_timestamp()
             ) AS activation
             JOIN spaces_namespace_authority_evidence AS authority
               ON authority.namespace_authority_reference=activation.spaces_namespace_authority_reference
              AND authority.namespace_authority_generation=activation.spaces_namespace_authority_generation
              AND authority.network=activation.spaces_network
              AND authority.canonical_root=activation.canonical_root
              AND authority.community_id=activation.community_id
             JOIN spaces_operator_assignment_current AS assignment
               ON assignment.operator_assignment_id=activation.spaces_operator_assignment_id
              AND assignment.current_generation=activation.spaces_operator_assignment_generation
              AND assignment.network=activation.spaces_network
              AND assignment.canonical_root=activation.canonical_root
              AND assignment.status='active'
             JOIN LATERAL (
               SELECT * FROM spaces_root_observations
                WHERE network=activation.spaces_network
                  AND canonical_root=activation.canonical_root
                ORDER BY observation_generation DESC LIMIT 1
             ) AS observation ON observation.fresh_until > clock_timestamp()
            WHERE activation.family='spaces'
              AND activation.canonical_root=$2
              AND activation.sale_namespace_activation_generation=$3`,
    values: [target.activationId, target.canonicalRoot, target.activationGeneration],
    readonly: true,
  });

const decodeBinding = (row: Row, target: Target): AuthorityBinding => ({
  ...target,
  network: text(row, "spaces_network"),
  rootKey: text(row, "root_key_hex"),
  outpoint: text(row, "root_outpoint"),
  delegationAddress: text(row, "delegation_address"),
  commitmentCount: integer(row, "commitment_count"),
  latestRoot: Schema.decodeUnknownSync(Schema.NullOr(LatestCommitment.fields.state_root))(
    row.latest_commitment_root_hex,
  ),
  authorityReference: text(row, "namespace_authority_reference"),
  authorityGeneration: integer(row, "namespace_authority_generation"),
  assignmentId: text(row, "operator_assignment_id"),
  assignmentGeneration: integer(row, "current_generation"),
});

/** The real capability is constructed only from the strict independent verifier. */
export function makeSpacesCurrentAuthority(
  observer: SpacesRootAuthorityObserver,
): NonNullable<SpacesCurrentAuthority> {
  return Effect.fn("makeSpacesCurrentAuthority.check")(
    function* (binding: AuthorityBinding) {
      if (binding.network !== "mainnet") return false;
      const result = yield* Effect.tryPromise((signal) =>
        observer.observe({ canonicalRoot: binding.canonicalRoot }, signal),
      );
      if (result.kind !== "verified") return false;
      return yield* Effect.try(() => {
        const evidence = result.evidence;
        const latest =
          evidence.commitment_count === 0
            ? null
            : Schema.decodeUnknownSync(LatestCommitment)(evidence.latest_commitment).state_root;
        return (
          evidence.network === binding.network &&
          evidence.root === `@${binding.canonicalRoot}` &&
          evidence.owner_xonly_key_hex === binding.rootKey &&
          evidence.outpoint === binding.outpoint &&
          evidence.operator_num_live &&
          evidence.reverse_delegation_matches &&
          evidence.operator_num_holder_script_pubkey_hex ===
            spacesDelegationScriptV1(binding.delegationAddress) &&
          evidence.commitment_count === binding.commitmentCount &&
          latest === binding.latestRoot
        );
      });
    },
    Effect.catch(() => Effect.succeed(false)),
  );
}

/** Never retain an old database clock or authorization across the external wait. */
export const hasCurrentSpacesAuthority = Effect.fn("hasCurrentSpacesAuthority")(
  function* (db: Reader, authority: SpacesCurrentAuthority, target: Target) {
    if (authority === null) return false;
    const before = yield* currentBinding(db, target);
    if (before.rows.length !== 1 || before.rows[0] === undefined) return false;
    const beforeRow = before.rows[0];
    const binding = yield* Effect.try(() => decodeBinding(beforeRow, target));
    if (!(yield* authority(binding))) return false;
    const after = yield* currentBinding(db, target);
    if (after.rows.length !== 1 || after.rows[0] === undefined) return false;
    const afterRow = after.rows[0];
    return yield* Effect.try(
      () => JSON.stringify(binding) === JSON.stringify(decodeBinding(afterRow, target)),
    );
  },
  Effect.catch(() => Effect.succeed(false)),
  Effect.timeoutOrElse({
    duration: DEADLINE,
    orElse: () => Effect.succeed(false),
  }),
);

export const requireCurrentSpacesAuthority = Effect.fn("requireCurrentSpacesAuthority")(function* (
  db: Reader,
  observer: SpacesCurrentAuthority,
  row: Row,
) {
  if (row.family !== "spaces") return;
  const current = yield* hasCurrentSpacesAuthority(db, observer, {
    activationId: text(row, "sale_namespace_activation_id"),
    activationGeneration: integer(row, "sale_namespace_activation_generation"),
    canonicalRoot: text(row, "namespace_root"),
  });
  if (!current) return yield* reject("sale_namespace_inactive", true);
});

/** Keep the original page cursor, including when every Spaces item is denied. */
export const filterCurrentSpacesOfferings = Effect.fn("filterCurrentSpacesOfferings")(function* (
  db: Reader,
  observer: SpacesCurrentAuthority,
  items: readonly CommunityHandleOfferingV4[],
) {
  const key = (item: CommunityHandleOfferingV4) =>
    JSON.stringify([
      item.sale_namespace_activation_id,
      item.sale_namespace_activation_generation,
      item.namespace_root,
    ]);
  const targets = new Map<string, Target>();
  for (const item of items) {
    if (item.family === "spaces")
      targets.set(key(item), {
        activationId: item.sale_namespace_activation_id,
        activationGeneration: item.sale_namespace_activation_generation,
        canonicalRoot: item.namespace_root,
      });
  }
  // Check at most three activation bindings in page order. Excess candidates
  // remain unavailable for this page; its original cursor still advances.
  // Keep completed successes if another root consumes the shared deadline.
  const active = new Set<string>();
  yield* Effect.forEach(
    Array.from(targets.entries()).slice(0, MAX_ROOTS),
    ([bindingKey, target]) =>
      hasCurrentSpacesAuthority(db, observer, target).pipe(
        Effect.flatMap((current) =>
          Effect.sync(() => {
            if (current) active.add(bindingKey);
          }),
        ),
      ),
    { concurrency: MAX_ROOTS },
  ).pipe(Effect.timeoutOrElse({ duration: DEADLINE, orElse: () => Effect.succeed([]) }));
  return items.filter((item) => item.family !== "spaces" || active.has(key(item)));
});
