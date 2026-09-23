import { readFile } from "node:fs/promises";
import {
  hnsObservedResourceMatchesEncodedPlanV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Schema } from "effect";
import {
  hsdRegtestAuthorization,
  hsdRegtestGenesis,
  hsdRegtestNode,
  hsdRegtestNodeUrl,
  hsdRegtestWallet,
  requireHsdRegtestChain,
} from "../../../../packages/platform-cf/src/hns-regtest-node.pg-fixture.ts";

/**
 * Chain leg of the staging HNS onboarding journey, run on the isolated staging
 * host against its loopback regtest node. It never chooses records: `publish`
 * sends exactly the replacement resource the product returned, after proving
 * it matches the product's encoded digest. Every command first proves the
 * pinned regtest genesis and loopback endpoints. Output is one JSON line.
 *
 *   acquire --root R                    register R to the fixture wallet (resumable)
 *   publish --root R --plan FILE        UPDATE R with FILE's replacement_records
 *   mine --blocks N                     1 <= N <= 60
 *   advance-safe --root R --plan FILE   mine one block at a time (max 60) until the
 *                                       maintained safe view carries FILE's digest
 *   status --root R                     current and safe observation summary
 */

const TREE_INTERVAL_BLOCKS = 5;
const SAFE_CONFIRMATIONS = 12;
const ROOT = /^[a-z0-9][a-z0-9-]{2,62}$/u;

class JourneyRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type JourneyCommand =
  | Readonly<{ kind: "acquire"; root: string }>
  | Readonly<{ kind: "publish"; root: string; plan: string }>
  | Readonly<{ kind: "mine"; blocks: number }>
  | Readonly<{ kind: "advance-safe"; root: string; plan: string }>
  | Readonly<{ kind: "status"; root: string }>;

export function parseJourneyCommand(argv: readonly string[]): JourneyCommand {
  const [kind, ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined || value.startsWith("--"))
      throw new JourneyRefusal("option_invalid");
    if (options.has(key)) throw new JourneyRefusal("option_duplicate");
    options.set(key, value);
  }
  const root = () => {
    const value = options.get("--root");
    if (value === undefined || !ROOT.test(value)) throw new JourneyRefusal("root_invalid");
    return value;
  };
  const only = (...allowed: string[]) => {
    for (const key of options.keys())
      if (!allowed.includes(key)) throw new JourneyRefusal("option_unexpected");
  };
  if (kind === "acquire" || kind === "status") {
    only("--root");
    return { kind, root: root() };
  }
  if (kind === "publish" || kind === "advance-safe") {
    only("--root", "--plan");
    const plan = options.get("--plan");
    if (plan === undefined || !plan.startsWith("/")) throw new JourneyRefusal("plan_path_invalid");
    return { kind, root: root(), plan };
  }
  if (kind === "mine") {
    only("--blocks");
    const blocks = Number(options.get("--blocks"));
    if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 60)
      throw new JourneyRefusal("blocks_invalid");
    return { kind, blocks };
  }
  throw new JourneyRefusal("command_invalid");
}

const Plan = Schema.Struct({
  root_label: Schema.String,
  replacement_records: Schema.Array(Schema.Unknown),
  encoded_resource_sha256: Schema.String,
});
type JourneyPlan = Schema.Schema.Type<typeof Plan>;

/** The plan must name this root and its records must encode to the product's digest. */
export async function requirePublishablePlan(root: string, raw: unknown) {
  let plan: JourneyPlan;
  try {
    plan = Schema.decodeUnknownSync(Plan)(raw);
  } catch {
    throw new JourneyRefusal("plan_shape");
  }
  if (plan.root_label !== root) throw new JourneyRefusal("plan_root_mismatch");
  if (!/^[0-9a-f]{64}$/u.test(plan.encoded_resource_sha256))
    throw new JourneyRefusal("plan_digest_invalid");
  let records: ReturnType<typeof validateHnsRootResourceRecordsV1>;
  let matches: boolean;
  try {
    records = validateHnsRootResourceRecordsV1(plan.replacement_records);
    matches = await hnsObservedResourceMatchesEncodedPlanV1(records, plan.encoded_resource_sha256);
  } catch {
    // The validator admits some shapes the wire encoder cannot represent.
    throw new JourneyRefusal("plan_records_invalid");
  }
  if (!matches) throw new JourneyRefusal("plan_digest_mismatch");
  return { records, digest: plan.encoded_resource_sha256 };
}

const observe = makeHsdRootResourceObserver({
  rpc_url: hsdRegtestNodeUrl,
  authorization: hsdRegtestAuthorization,
  chain_network: "regtest",
  genesis_block_hash: hsdRegtestGenesis,
  tree_interval_blocks: TREE_INTERVAL_BLOCKS,
  safe_minimum_confirmations: SAFE_CONFIRMATIONS,
  maximum_tip_age_seconds: 86_400,
  maximum_future_tip_seconds: 3600,
});

async function miningAddress(): Promise<string> {
  const address = Schema.decodeUnknownSync(Schema.String)(await hsdRegtestWallet("getnewaddress"));
  if (!address.startsWith("rs1")) throw new JourneyRefusal("wallet_not_regtest");
  return address;
}
const mine = async (blocks: number) =>
  hsdRegtestNode("generatetoaddress", [blocks, await miningAddress()]);
const tip = async () =>
  Schema.decodeUnknownSync(Schema.Number)(await hsdRegtestNode("getblockcount"));

const NameInfo = Schema.Struct({
  info: Schema.NullOr(
    Schema.Struct({
      state: Schema.String,
      owner: Schema.Struct({ hash: Schema.String, index: Schema.Number }),
    }),
  ),
});
async function nameState(root: string): Promise<string | null> {
  const info = Schema.decodeUnknownSync(NameInfo)(await hsdRegtestNode("getnameinfo", [root]));
  return info.info?.state ?? null;
}
async function ownedByWallet(root: string): Promise<boolean> {
  const owned = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
    await hsdRegtestWallet("getnames", [true]),
  );
  return owned.some((entry) => entry.name === root);
}

async function acquire(root: string) {
  // Resumable: advance from whatever auction state the name is in, but only for
  // a name that is unowned or already owned by this fixture wallet.
  if ((await tip()) < 120) await mine(120);
  let state = await nameState(root);
  if (state === "CLOSED") {
    if (!(await ownedByWallet(root))) throw new JourneyRefusal("name_owned_elsewhere");
    return { outcome: "acquired", root, resumed: true, height: await tip() };
  }
  if (state === null) {
    await hsdRegtestWallet("sendopen", [root]);
    await mine(8);
    state = await nameState(root);
  }
  if (state === "OPENING") {
    await mine(8);
    state = await nameState(root);
  }
  if (state === "BIDDING") {
    await hsdRegtestWallet("sendbid", [root, 5, 10]);
    await mine(6);
    state = await nameState(root);
  }
  if (state === "REVEAL") {
    await hsdRegtestWallet("sendreveal", [root]);
    await mine(12);
    state = await nameState(root);
  }
  if (state !== "CLOSED" || !(await ownedByWallet(root)))
    throw new JourneyRefusal(`auction_state_${state ?? "none"}`);
  // Registration establishes the empty initial resource; it is not the UPDATE.
  await hsdRegtestWallet("sendupdate", [root, { records: [] }]);
  await mine(10);
  return { outcome: "acquired", root, resumed: false, height: await tip() };
}

async function publish(root: string, planPath: string) {
  const { records, digest } = await requirePublishablePlan(
    root,
    JSON.parse(await readFile(planPath, "utf8")),
  );
  if (!(await ownedByWallet(root))) throw new JourneyRefusal("name_not_owned");
  const current = await observe(root, "current");
  if (
    current.kind === "observed" &&
    (await hnsObservedResourceMatchesEncodedPlanV1(current.observation.records, digest))
  )
    return { outcome: "already_current", root, digest, height: await tip() };
  const update = Schema.decodeUnknownSync(
    Schema.Struct({
      hash: Schema.String,
      outputs: Schema.Array(Schema.Struct({ covenant: Schema.Struct({ action: Schema.String }) })),
    }),
  )(await hsdRegtestWallet("sendupdate", [root, { records }]));
  if (!update.outputs.some((output) => output.covenant.action === "UPDATE"))
    throw new JourneyRefusal("not_an_update");
  await mine(1);
  const inclusion = await tip();
  return { outcome: "published", root, digest, txid: update.hash, inclusion_height: inclusion };
}

/** Empirical, not computed: the maintained observer decides when the safe view
 * selects a commitment that contains the published resource. */
async function advanceSafe(root: string, planPath: string) {
  const { digest } = await requirePublishablePlan(
    root,
    JSON.parse(await readFile(planPath, "utf8")),
  );
  const current = await observe(root, "current");
  if (
    current.kind !== "observed" ||
    !(await hnsObservedResourceMatchesEncodedPlanV1(current.observation.records, digest))
  )
    throw new JourneyRefusal("plan_not_current");
  for (let mined = 0; mined <= 60; mined += 1) {
    const safe = await observe(root, "safe");
    if (
      safe.kind === "observed" &&
      (await hnsObservedResourceMatchesEncodedPlanV1(safe.observation.records, digest))
    )
      return {
        outcome: "safe",
        root,
        digest,
        blocks_mined: mined,
        safe_tip: safe.observation.tip_height,
      };
    if (mined < 60) await mine(1);
  }
  throw new JourneyRefusal("safe_not_reached_within_60_blocks");
}

async function status(root: string) {
  const summary = async (view: "current" | "safe") => {
    const result = await observe(root, view);
    return result.kind === "observed"
      ? {
          kind: result.kind,
          tip: result.observation.tip_height,
          records: result.observation.records.length,
        }
      : { kind: result.kind };
  };
  return {
    outcome: "status",
    root,
    height: await tip(),
    state: await nameState(root),
    owned: await ownedByWallet(root),
    current: await summary("current"),
    safe: await summary("safe"),
  };
}

async function runJourneyCommand(argv: readonly string[]) {
  const command = parseJourneyCommand(argv);
  await requireHsdRegtestChain();
  if (command.kind === "mine") {
    await mine(command.blocks);
    return { outcome: "mined", blocks: command.blocks, height: await tip() };
  }
  if (command.kind === "acquire") return acquire(command.root);
  if (command.kind === "publish") return publish(command.root, command.plan);
  if (command.kind === "advance-safe") return advanceSafe(command.root, command.plan);
  return status(command.root);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runJourneyCommand(Bun.argv.slice(2))));
  } catch (error) {
    // RPC errors can carry endpoint details; print a fixed code only.
    console.error(
      JSON.stringify({
        outcome: "journey_chain_refused",
        code: error instanceof JourneyRefusal ? error.code : "unexpected",
      }),
    );
    process.exitCode = 1;
  }
}
