import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
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
import {
  claimPublishAttempt,
  finalizePublishAttempt,
  JOURNEY_ROOT,
  JOURNEY_STATE_DIRECTORY,
  JourneyDispatchAmbiguity,
  JourneyRefusal,
  journeyFailureOutput,
  readPublishAttempt,
  requirePrivateStateDirectory,
} from "./journey-publish-receipt.ts";

/**
 * Chain leg of the staging HNS onboarding journey, run on the isolated staging
 * host against its loopback regtest node. It never chooses records: `publish`
 * sends exactly the replacement resource from a product session
 * response, after proving the response-byte, complete plan-document and
 * encoded-resource digests and checking that the provisioner created a zone
 * for its challenge and DS.
 * The runner supplying FILE must fetch that response through the maintained
 * authenticated API path; a copied file alone cannot prove authentication.
 * Every command first proves the pinned regtest genesis and loopback endpoints.
 * Mutating commands require the host-wide run lease naming their root; a
 * stale lease is never evicted automatically. Output is one JSON line.
 *
 *   begin --root R                      take the exclusive run lease for R
 *   acquire --root R                    register R to the fixture wallet (resumable)
 *   publish --root R --plan FILE --response-sha256 H
 *                                       UPDATE R with FILE's session publish_plan
 *   mine --root R --blocks N            1 <= N <= 60
 *   end --root R                        release R's run lease
 *   advance-safe --root R --plan FILE --response-sha256 H
 *                                       mine one block at a time (max 60) until the
 *                                       maintained safe view carries FILE's digest
 *   status --root R                     current and safe observation summary
 */

const TREE_INTERVAL_BLOCKS = 5;
const SAFE_CONFIRMATIONS = 12;
// Only journey-generated names; never an operator- or owner-supplied root.
const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHORITY_API = "http://127.0.0.21:8081";
const AUTHORITY_KEY = "isolated-hns-authority-fixture-only";

export type JourneyCommand =
  | Readonly<{ kind: "begin"; root: string }>
  | Readonly<{ kind: "end"; root: string }>
  | Readonly<{ kind: "acquire"; root: string }>
  | Readonly<{ kind: "publish"; root: string; plan: string; responseSha256: string }>
  | Readonly<{ kind: "mine"; root: string; blocks: number }>
  | Readonly<{ kind: "advance-safe"; root: string; plan: string; responseSha256: string }>
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
    if (value === undefined || !JOURNEY_ROOT.test(value)) throw new JourneyRefusal("root_invalid");
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
    only("--root", "--plan", "--response-sha256");
    const plan = options.get("--plan");
    if (plan === undefined || !plan.startsWith("/")) throw new JourneyRefusal("plan_path_invalid");
    const responseSha256 = options.get("--response-sha256");
    if (responseSha256 === undefined || !/^[0-9a-f]{64}$/u.test(responseSha256))
      throw new JourneyRefusal("response_digest_invalid");
    return { kind, root: root(), plan, responseSha256 };
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
  // The document hash binds the complete plan document. Rebuilding from the
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

/** A copied file is admitted only if its exact bytes match the authenticated
 * fetch receipt supplied by the browser runner. The receipt's provenance is
 * established outside this host CLI, not inferred from JSON fields. */
export async function requireBoundSessionResponse(
  root: string,
  bytes: Uint8Array,
  expectedSha256: string,
) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) throw new JourneyRefusal("response_digest_invalid");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new JourneyRefusal("response_digest_mismatch");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new JourneyRefusal("session_response_json_invalid");
  }
  return { ...(await requireSessionPlan(root, raw)), response_sha256: actual };
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
 * Consistency check without API credentials: the product's provisioner stamps
 * each zone with an account derived from the import challenge and holds its
 * DNSSEC keys. This is not proof of authenticated API provenance: a writer
 * with access to the fixture authority could create the same marker and DS.
 */
export async function requirePlanProvenance(
  root: string,
  records: Records,
  fetcher: AuthorityFetch = fetch,
  apiUrl = AUTHORITY_API,
  apiKey = AUTHORITY_KEY,
): Promise<void> {
  const base = new URL(apiUrl);
  if (base.href !== `${AUTHORITY_API}/`) throw new JourneyRefusal("authority_not_loopback");
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

const leasePath = () => join(JOURNEY_STATE_DIRECTORY, "lease.json");

async function beginLease(root: string) {
  await requirePrivateStateDirectory();
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
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { outcome: "lease_taken", root };
}

async function requireLease(root: string) {
  await requirePrivateStateDirectory();
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
    throw new JourneyRefusal("auction_state_unexpected");
  // Registration establishes the empty initial resource; it is not the UPDATE.
  await hsdRegtestWallet("sendupdate", [root, { records: [] }]);
  await mine(10);
  return { outcome: "acquired", root, resumed: false, height: await tip() };
}

async function publish(root: string, planPath: string, responseSha256: string) {
  const { records, digest, root_import_session_id, publish_plan_sha256, response_sha256 } =
    await requireBoundSessionResponse(root, await readFile(planPath), responseSha256);
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
      response_sha256,
      height: await tip(),
    };
  // Only the empty registration resource may be replaced; anything else is
  // someone else's state and is reconciled by a person, not overwritten.
  if (current.observation.records.length !== 0)
    throw new JourneyRefusal("pre_update_resource_not_empty");
  await requirePlanProvenance(root, records);
  const attempt = {
    root,
    root_import_session_id,
    publish_plan_sha256,
    encoded_resource_sha256: digest,
    response_sha256,
  };
  const receipt = await claimPublishAttempt(attempt);
  // From here on an update may already be broadcast. Nothing below is a clean
  // refusal, and no txid is ever reported unless the wallet returned one.
  let txid: string | null = null;
  try {
    const raw = await hsdRegtestWallet("sendupdate", [root, { records }]);
    let update: { hash: string; outputs: readonly { covenant: { action: string } }[] };
    try {
      update = Schema.decodeUnknownSync(
        Schema.Struct({
          hash: Schema.String,
          outputs: Schema.Array(
            Schema.Struct({ covenant: Schema.Struct({ action: Schema.String }) }),
          ),
        }),
      )(raw);
    } catch {
      throw new JourneyDispatchAmbiguity("update_response_unparseable", null, receipt);
    }
    if (!SHA256.test(update.hash))
      throw new JourneyDispatchAmbiguity("update_txid_invalid", null, receipt);
    txid = update.hash;
    if (!update.outputs.some((output) => output.covenant.action === "UPDATE"))
      throw new JourneyDispatchAmbiguity("not_an_update", txid, receipt);
    await finalizePublishAttempt(attempt, { status: "broadcasted", txid });
    await mine(1);
    const inclusion = await confirmedHeight(txid);
    if (inclusion === null)
      return {
        outcome: "broadcast_unconfirmed",
        root,
        digest,
        root_import_session_id,
        publish_plan_sha256,
        response_sha256,
        txid,
        receipt,
      };
    await finalizePublishAttempt(attempt, {
      status: "included",
      txid,
      inclusion_height: inclusion,
    });
    return {
      outcome: "published",
      root,
      digest,
      root_import_session_id,
      publish_plan_sha256,
      response_sha256,
      txid,
      inclusion_height: inclusion,
      receipt,
    };
  } catch (error) {
    if (error instanceof JourneyDispatchAmbiguity) throw error;
    throw new JourneyDispatchAmbiguity(
      error instanceof JourneyRefusal ? error.code : "post_claim_failure",
      txid,
      receipt,
    );
  }
}

/** The height of the block containing txid, or null while it is unconfirmed.
 * Inclusion is read from the node, never inferred from the tip after mining. */
async function confirmedHeight(txid: string): Promise<number | null> {
  const TxView = Schema.Struct({
    confirmations: Schema.optional(Schema.Number),
    blockhash: Schema.optional(Schema.NullOr(Schema.String)),
  });
  let raw: unknown;
  try {
    raw = await hsdRegtestNode("getrawtransaction", [txid, 1]);
  } catch (error) {
    // hsd answers "Transaction not found" until the transaction is in a block
    // (observed on regtest); only that answer means unconfirmed.
    if (error instanceof Error && error.message.includes("Transaction not found")) return null;
    throw error;
  }
  const view = Schema.decodeUnknownSync(TxView)(raw);
  if (!view.blockhash || !view.confirmations || view.confirmations < 1) return null;
  return (await tip()) - view.confirmations + 1;
}

/** Empirical, not computed: the maintained observer decides when the safe view
 * selects a commitment that contains the published resource. */
async function advanceSafe(root: string, planPath: string, responseSha256: string) {
  const { digest, response_sha256 } = await requireBoundSessionResponse(
    root,
    await readFile(planPath),
    responseSha256,
  );
  const matches = async (view: "current" | "safe") => {
    const observed = await observe(root, view);
    return observed.kind === "observed" &&
      (await hnsObservedResourceMatchesEncodedPlanV1(observed.observation.records, digest))
      ? observed
      : null;
  };
  if (!(await matches("current"))) {
    // Mining may continue only for this root's own fenced broadcast of the
    // same response; it never sends another update.
    const receipt = await readPublishAttempt(root);
    if (
      receipt.state !== "present" ||
      (receipt.status !== "broadcasted" && receipt.status !== "included") ||
      receipt.response_sha256 !== response_sha256
    )
      throw new JourneyRefusal("plan_not_current");
  }
  for (let mined = 0; mined <= 60; mined += 1) {
    const safe = (await matches("current")) ? await observe(root, "safe") : null;
    if (
      safe !== null &&
      safe.kind === "observed" &&
      (await hnsObservedResourceMatchesEncodedPlanV1(safe.observation.records, digest))
    )
      return {
        outcome: "safe",
        root,
        digest,
        response_sha256,
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
    receipt: await readPublishAttempt(root),
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
  if (command.kind === "publish")
    return publish(command.root, command.plan, command.responseSha256);
  return advanceSafe(command.root, command.plan, command.responseSha256);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await runJourneyCommand(Bun.argv.slice(2))));
  } catch (error) {
    // RPC errors can carry endpoint details; print fixed fields only.
    const rootArgument = Bun.argv.slice(2)[Bun.argv.slice(2).indexOf("--root") + 1];
    const root =
      typeof rootArgument === "string" && JOURNEY_ROOT.test(rootArgument) ? rootArgument : null;
    const failure = journeyFailureOutput(error, root);
    console.error(JSON.stringify(failure.line));
    process.exitCode = failure.exitCode;
  }
}
