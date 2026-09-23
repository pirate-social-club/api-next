import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHnsRootImportPublishPlanV1,
  type HnsRootDelegationDsV1,
  hnsObservedResourceMatchesEncodedPlanV1,
  validateHnsRootResourceRecordsV1,
} from "@pirate/application/namespace-ownership";
import { canonicalJson } from "@pirate/domain";
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
import { reservationAccount, retainedDsRecords } from "../../src/powerdns.ts";

/**
 * Chain leg of the staging HNS onboarding journey, run on the isolated staging
 * host against its loopback regtest node. It never chooses records: `publish`
 * sends exactly the replacement resource from a product session
 * response, after proving its complete plan-document and encoded-resource
 * digests and that the provisioner created a zone for its challenge and DS.
 * The runner supplying FILE must fetch that response through the maintained
 * authenticated API path; a copied file alone cannot prove authentication.
 * Every command first proves the pinned regtest genesis and loopback endpoints.
 * Mutating commands require the host-wide run lease naming their root; a
 * stale lease is never evicted automatically. Output is one JSON line.
 *
 *   begin --root R                      take the exclusive run lease for R
 *   acquire --root R                    register R to the fixture wallet (resumable)
 *   publish --root R --plan FILE        UPDATE R with FILE's session publish_plan
 *   mine --root R --blocks N            1 <= N <= 60
 *   end --root R                        release R's run lease
 *   advance-safe --root R --plan FILE   mine one block at a time (max 60) until the
 *                                       maintained safe view carries FILE's digest
 *   status --root R                     current and safe observation summary
 */

const TREE_INTERVAL_BLOCKS = 5;
const SAFE_CONFIRMATIONS = 12;
// Only journey-generated names; never an operator- or owner-supplied root.
const ROOT = /^e2e[a-z0-9]{6,40}$/u;
const LEASE_DIRECTORY = process.env.HNS_JOURNEY_LEASE_DIR ?? "/var/tmp/pirate-hns-staging-journey";
const AUTHORITY_API = process.env.HNS_JOURNEY_PDNS_API_URL ?? "http://127.0.0.21:8081";
const AUTHORITY_KEY = process.env.HNS_JOURNEY_PDNS_API_KEY ?? "isolated-hns-authority-fixture-only";

class JourneyRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type JourneyCommand =
  | Readonly<{ kind: "begin"; root: string }>
  | Readonly<{ kind: "end"; root: string }>
  | Readonly<{ kind: "acquire"; root: string }>
  | Readonly<{ kind: "publish"; root: string; plan: string }>
  | Readonly<{ kind: "mine"; root: string; blocks: number }>
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
  if (kind === "acquire" || kind === "status" || kind === "begin" || kind === "end") {
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
    only("--root", "--blocks");
    const blocks = Number(options.get("--blocks"));
    if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > 60)
      throw new JourneyRefusal("blocks_invalid");
    return { kind, root: root(), blocks };
  }
  throw new JourneyRefusal("command_invalid");
}

const Plan = Schema.Struct({
  version: Schema.Literal("pirate-hns-root-import-publish-plan-v1"),
  replacement_semantics: Schema.Literal("complete_resource"),
  current_records: Schema.Array(Schema.Unknown),
  preserved_records: Schema.Array(Schema.Unknown),
  removed_conflicts: Schema.Array(Schema.Unknown),
  added_records: Schema.Array(Schema.Unknown),
  root_label: Schema.optional(Schema.String),
  replacement_records: Schema.Array(Schema.Unknown),
  preserved_unknown_record_types: Schema.Array(Schema.String),
  encoded_resource_sha256: Schema.String,
  acknowledgement_required: Schema.Literal(true),
});
type JourneyPlan = Schema.Schema.Type<typeof Plan>;

const SessionPlanResponse = Schema.Struct({
  community_id: Schema.String,
  root_import_session_id: Schema.String,
  root_label: Schema.String,
  status: Schema.String,
  publish_plan: Schema.Unknown,
  publish_plan_sha256: Schema.String,
});

/** The plan must have complete-resource semantics and encode to its digest.
 * Root binding comes from the surrounding product session response. */
export async function requirePublishablePlan(root: string, raw: unknown) {
  let plan: JourneyPlan;
  try {
    plan = Schema.decodeUnknownSync(Plan)(raw);
  } catch {
    throw new JourneyRefusal("plan_shape");
  }
  if (plan.root_label !== undefined && plan.root_label !== root)
    throw new JourneyRefusal("plan_root_mismatch");
  if (
    plan.current_records.length !== 0 ||
    plan.preserved_records.length !== 0 ||
    plan.removed_conflicts.length !== 0 ||
    canonicalJson(plan.replacement_records) !== canonicalJson(plan.added_records)
  )
    throw new JourneyRefusal("plan_not_for_empty_registration");
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

/** Bind every plan field to the product's session response, not merely its
 * challenge and DS records. The caller must obtain this response via the
 * authenticated API; the chain CLI cannot authenticate a local file. */
export async function requireSessionPlan(root: string, raw: unknown) {
  let response: Schema.Schema.Type<typeof SessionPlanResponse>;
  try {
    response = Schema.decodeUnknownSync(SessionPlanResponse)(raw);
  } catch {
    throw new JourneyRefusal("session_response_shape");
  }
  if (
    response.root_label !== root ||
    response.community_id.length === 0 ||
    response.root_import_session_id.length === 0
  )
    throw new JourneyRefusal("session_identity_mismatch");
  if (response.status !== "awaiting_owner_update" && response.status !== "observing")
    throw new JourneyRefusal("session_not_awaiting_update");
  if (!/^[0-9a-f]{64}$/u.test(response.publish_plan_sha256))
    throw new JourneyRefusal("plan_document_digest_invalid");
  let documentDigest: string;
  try {
    documentDigest = createHash("sha256")
      .update(canonicalJson(response.publish_plan))
      .digest("hex");
  } catch {
    throw new JourneyRefusal("plan_document_invalid");
  }
  if (documentDigest !== response.publish_plan_sha256)
    throw new JourneyRefusal("plan_document_digest_mismatch");
  const plan = await requirePublishablePlan(root, response.publish_plan);
  // The document hash binds all fields of the response. Rebuilding from the
  // empty registration, challenge and DS additionally refuses an altered NS
  // or unrelated TXT even if someone recomputes both hashes in a copied file.
  let expectedPlan: Awaited<ReturnType<typeof buildHnsRootImportPublishPlanV1>>;
  try {
    expectedPlan = await buildHnsRootImportPublishPlanV1({
      current_records: [],
      challenge_txt_value: planChallenge(plan.records),
      ds_records: planDs(plan.records),
    });
  } catch {
    throw new JourneyRefusal("plan_not_product_build");
  }
  if (canonicalJson(expectedPlan) !== canonicalJson(response.publish_plan))
    throw new JourneyRefusal("plan_not_product_build");
  return {
    ...plan,
    community_id: response.community_id,
    root_import_session_id: response.root_import_session_id,
    publish_plan_sha256: documentDigest,
  };
}

type Records = ReturnType<typeof validateHnsRootResourceRecordsV1>;

function planChallenge(records: Records): string {
  const challenges = records.flatMap((record) =>
    record.type === "TXT" && Array.isArray(record.txt)
      ? [record.txt.join("")].filter((value) => value.startsWith("pirate-verification="))
      : [],
  );
  if (challenges.length !== 1) throw new JourneyRefusal("plan_challenge_not_unique");
  return challenges[0] as string;
}

function planDs(records: Records): HnsRootDelegationDsV1[] {
  const ds = records.flatMap((record) => {
    if (record.type !== "DS") return [];
    const { keyTag, algorithm, digestType, digest } = record as Record<string, unknown>;
    if (
      typeof keyTag !== "number" ||
      typeof algorithm !== "number" ||
      (digestType !== 2 && digestType !== 4) ||
      typeof digest !== "string"
    )
      throw new JourneyRefusal("plan_ds_invalid");
    const entry: HnsRootDelegationDsV1 = {
      key_tag: keyTag,
      algorithm,
      digest_type: digestType,
      digest: digest.toLowerCase(),
    };
    return [entry];
  });
  return ds.sort(
    (left, right) =>
      left.key_tag - right.key_tag ||
      left.algorithm - right.algorithm ||
      left.digest_type - right.digest_type,
  );
}

type AuthorityFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Provenance without API credentials: the product's provisioner stamps each
 * zone with an account derived from the import challenge and holds its DNSSEC
 * keys. A plan is publishable only if such a zone exists for its exact
 * challenge and its DS set equals the zone's active DS set.
 */
export async function requirePlanProvenance(
  root: string,
  records: Records,
  fetcher: AuthorityFetch = fetch,
  apiUrl = AUTHORITY_API,
  apiKey = AUTHORITY_KEY,
): Promise<void> {
  const base = new URL(apiUrl);
  if (base.protocol !== "http:" || !base.hostname.startsWith("127."))
    throw new JourneyRefusal("authority_not_loopback");
  const get = async (path: string) => {
    const response = await fetcher(
      `${base.origin}/api/v1/servers/localhost/zones/${root}.${path}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { accept: "application/json", "x-api-key": apiKey },
      },
    );
    if (response.status === 404) throw new JourneyRefusal("plan_zone_absent");
    if (!response.ok) throw new JourneyRefusal("authority_unreadable");
    return (await response.json()) as unknown;
  };
  const challenge = planChallenge(records);
  const zone = (await get("")) as { account?: unknown };
  if (zone.account !== (await reservationAccount(challenge)))
    throw new JourneyRefusal("plan_not_from_product_provisioning");
  const keys = await get("/cryptokeys");
  if (!Array.isArray(keys)) throw new JourneyRefusal("authority_unreadable");
  const zoneDs = retainedDsRecords(
    (keys as { active?: unknown; published?: unknown; ds?: unknown }[])
      .filter((key) => key.active !== false && key.published !== false)
      .flatMap((key) =>
        Array.isArray(key.ds) ? key.ds.filter((v): v is string => typeof v === "string") : [],
      ),
  );
  if (JSON.stringify(zoneDs) !== JSON.stringify(planDs(records)))
    throw new JourneyRefusal("plan_ds_differs_from_zone");
}

const leasePath = () => join(LEASE_DIRECTORY, "lease.json");

async function beginLease(root: string) {
  await mkdir(LEASE_DIRECTORY, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(leasePath(), "wx", 0o600);
  } catch {
    throw new JourneyRefusal("run_lease_held");
  }
  try {
    await handle.writeFile(
      JSON.stringify({ root, pid: process.pid, started_at: new Date().toISOString() }),
    );
  } finally {
    await handle.close();
  }
  return { outcome: "lease_taken", root };
}

async function requireLease(root: string) {
  let lease: { root?: unknown };
  try {
    lease = JSON.parse(await readFile(leasePath(), "utf8")) as { root?: unknown };
  } catch {
    throw new JourneyRefusal("run_lease_missing");
  }
  if (lease.root !== root) throw new JourneyRefusal("run_lease_names_other_root");
}

async function endLease(root: string) {
  await requireLease(root);
  await unlink(leasePath());
  return { outcome: "lease_released", root };
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
  const { records, digest, root_import_session_id, publish_plan_sha256 } = await requireSessionPlan(
    root,
    JSON.parse(await readFile(planPath, "utf8")),
  );
  if (!(await ownedByWallet(root))) throw new JourneyRefusal("name_not_owned");
  const current = await observe(root, "current");
  if (current.kind !== "observed") throw new JourneyRefusal("current_unobservable");
  if (await hnsObservedResourceMatchesEncodedPlanV1(current.observation.records, digest))
    return {
      outcome: "already_current",
      root,
      digest,
      root_import_session_id,
      publish_plan_sha256,
      height: await tip(),
    };
  // Only the empty registration resource may be replaced; anything else is
  // someone else's state and is reconciled by a person, not overwritten.
  if (current.observation.records.length !== 0)
    throw new JourneyRefusal("pre_update_resource_not_empty");
  await requirePlanProvenance(root, records);
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
  return {
    outcome: "published",
    root,
    digest,
    root_import_session_id,
    publish_plan_sha256,
    txid: update.hash,
    inclusion_height: inclusion,
  };
}

/** Empirical, not computed: the maintained observer decides when the safe view
 * selects a commitment that contains the published resource. */
async function advanceSafe(root: string, planPath: string) {
  const { digest } = await requireSessionPlan(root, JSON.parse(await readFile(planPath, "utf8")));
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
  if (command.kind === "begin") return beginLease(command.root);
  if (command.kind === "status") return status(command.root);
  await requireLease(command.root);
  if (command.kind === "end") return endLease(command.root);
  if (command.kind === "mine") {
    await mine(command.blocks);
    return { outcome: "mined", blocks: command.blocks, height: await tip() };
  }
  if (command.kind === "acquire") return acquire(command.root);
  if (command.kind === "publish") return publish(command.root, command.plan);
  return advanceSafe(command.root, command.plan);
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
