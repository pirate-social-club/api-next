import { createHash } from "node:crypto";
import type { Client } from "pg";
import { decodeHnsRootImportReadinessResultV1 } from "../../application/src/namespace-ownership/hns-root-import-readiness.ts";
import { promoteImportedHnsInventorySuccessor } from "./hns-imported-inventory-successor.ts";
import {
  type HnsZoneAdoptionDeltaKind,
  hnsZoneAdoptionSerialV1,
  hnsZoneHoldsWildcardAddressFamilyV1,
  requireHnsZoneAdoptionDeltaV1,
} from "./hns-zone-adoption-delta.ts";

/**
 * Operator adoption of a changed zone for one activated root.
 *
 * Renewal promotes a successor only when the zone the authorities serve
 * equals the retained one. Adoption promotes the same successor, built by the
 * same function from the same kind of observation, when the served zone
 * differs from the retained one by exactly a difference
 * `requireHnsZoneAdoptionDeltaV1` admits and the operator named. Every other
 * binding the renewal preparation checks about the root is checked here
 * against the same rows. It is not a job: an operator runs it between
 * renewals.
 *
 * Adoption bounds the reviewed observation's age on the database clock, then
 * runs the full observer again under the database fence. It compares the
 * canonical zone, serial, keyset, chain and gateway bindings. DNS has no
 * transaction shared with PostgreSQL: exclusive authority-writer custody is
 * required until commit even after that check.
 *
 * The session and DNS pointer locks serialize adoption with renewal. An open
 * job does not block adoption; a later claim ends it as generation_superseded.
 * A preparation already waiting on the old snapshot instead aborts with a
 * serialization error, leaving termination to a later claim.
 *
 * The zone changes first, under withHnsRootZoneAdoptionFence. The fence refuses
 * starting a departure from the retained wildcard family while a renewal job
 * is open or expiry is near. It permits completion of an interrupted change
 * and restoration of the retained family, so a queued job cannot strand a
 * partly changed zone. The operator must finish adoption or restoration.

 */

/** How old an observation may be when it is adopted, dry runs included. */
const MAXIMUM_OBSERVATION_AGE_SECONDS = 900;

export type HnsZoneAdoptionMode = "dry-run" | "rehearse" | "commit";

export class HnsZoneAdoptionRefusal extends Error {
  override readonly name = "HnsZoneAdoptionRefusal";
}

export class HnsZoneAdoptionCommitUnknown extends Error {
  override readonly name = "HnsZoneAdoptionCommitUnknown";
  constructor() {
    super(
      "HNS zone adoption commit outcome is unknown; read the root's generation before any retry",
    );
  }
}

export type HnsZoneAdoptionReceipt = Readonly<{
  mode: HnsZoneAdoptionMode;
  committed: boolean;
  root_label: string;
  root_import_session_id: string;
  delta: HnsZoneAdoptionDeltaKind;
  result_sha256: string;
  previous_generation: number;
  next_generation: number;
  previous_zone_bytes_sha256: string;
  next_zone_bytes_sha256: string;
  authority_inventory_version: string;
  valid_until: string;
  /** Renewal jobs open at the superseded generation; each ends as generation_superseded. */
  open_renewal_jobs: number;
  database_time: string;
}>;

/** What adoption needs to know about an activated root, read in one statement. */
export type HnsRootZoneAdoptionState = Readonly<{
  root_label: string;
  root_import_session_id: string;
  session_status: string;
  namespace_session_id: string | null;
  challenge_txt_value: string | null;
  ownership_result_sha256: string | null;
  publish_plan_sha256: string | null;
  publish_plan_bytes: Uint8Array | null;
  /** The session's expiry as the observation request encodes it. */
  session_expires_at: string | null;
  provision_publish_plan_sha256: string | null;
  provision_result_sha256: string | null;
  provision_result_bytes: Uint8Array | null;
  dns_zone_activation_id: string;
  current_generation: number;
  retained_zone_bytes: Uint8Array;
  retained_zone_bytes_sha256: string;
  dnssec_keyset_reference: string;
  dnssec_keyset_version: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  stable_chain_delegation_snapshot_reference: string;
  /** Renewal jobs for the current generation that are queued, leased or delayed. */
  open_renewal_jobs: number;
  /** The earlier of the current health and inventory expiries, as the scheduler reads it. */
  serving_valid_until: string | null;
  serving_valid_for_seconds: number | null;
  database_time: string;
}>;

type StateRow = {
  root_import_session_id: string;
  session_status: string;
  namespace_session_id: string | null;
  challenge_txt_value: string | null;
  ownership_result_sha256: string | null;
  session_publish_plan_sha256: string | null;
  publish_plan_bytes: Uint8Array | null;
  session_expires_at: string | null;
  provision_publish_plan_sha256: string | null;
  provision_result_sha256: string | null;
  provision_result_bytes: Uint8Array | null;
  dns_zone_activation_id: string;
  current_generation: string;
  zone_bytes: Uint8Array;
  zone_bytes_digest: string;
  dnssec_keyset_reference: string;
  dnssec_keyset_version: string;
  gateway_deployment_reference: string;
  gateway_certificate_spki_sha256: string;
  stable_chain_delegation_snapshot_reference: string;
  open_renewal_jobs: string;
  serving_valid_until: Date | null;
  database_time: Date;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const optionalBytes = (value: Uint8Array | null) => (value === null ? null : new Uint8Array(value));

function refuse(reason: string): never {
  throw new HnsZoneAdoptionRefusal(reason);
}

/**
 * Reads the root's state inside the caller's transaction. With `lock` it takes
 * the session and DNS pointer rows the renewal preparation takes, in the same
 * order, so an adoption and a renewal of one root cannot both promote, and a
 * renewal claim, which shares those rows, waits. The lock is the weaker
 * no-key one: it excludes both of those and still lets a row that only
 * refers to the session, such as a newly scheduled job, be inserted. A
 * session is named exactly
 * when the caller holds an observation bound to one; otherwise the root's
 * activated session is read.
 */
async function selectState(
  client: Client,
  rootLabel: string,
  sessionId: string | null,
  lock: boolean,
): Promise<HnsRootZoneAdoptionState> {
  const rows = await client.query<StateRow>(
    `SELECT session.root_import_session_id, session.status AS session_status,
            session.namespace_session_id, session.challenge_txt_value,
            session.ownership_result_sha256,
            session.publish_plan_sha256 AS session_publish_plan_sha256,
            session.publish_plan_bytes,
            to_char(date_trunc('milliseconds', session.expires_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS session_expires_at,
            provision.publish_plan_sha256 AS provision_publish_plan_sha256,
            provision.result_sha256 AS provision_result_sha256,
            provision.result_bytes AS provision_result_bytes,
            dns.dns_zone_activation_id, dns.current_generation::text AS current_generation,
            revision.zone_bytes, revision.zone_bytes_digest,
            revision.dnssec_keyset_reference, revision.dnssec_keyset_version,
            revision.gateway_deployment_reference, revision.gateway_certificate_spki_sha256,
            revision.stable_chain_delegation_snapshot_reference,
            (SELECT count(*) FROM hns_root_health_renewal_jobs AS job
              WHERE job.dns_zone_activation_id = dns.dns_zone_activation_id
                AND job.activation_generation = dns.current_generation
                AND job.state IN ('queued', 'leased', 'delayed'))::text AS open_renewal_jobs,
            (SELECT LEAST(health.valid_until, inventory.expires_at)
               FROM hns_dns_zone_health_observations AS health
               JOIN hns_authority_inventories AS inventory
                 ON inventory.authority_inventory_reference
                      = revision.pirate_dns_authority_inventory_reference
                AND inventory.authority_inventory_version
                      = revision.pirate_dns_authority_inventory_version
                AND inventory.authority_inventory_digest
                      = revision.pirate_dns_authority_inventory_digest
              WHERE health.dns_zone_activation_id = dns.dns_zone_activation_id
                AND health.activation_generation = dns.current_generation
              ORDER BY health.health_generation DESC LIMIT 1) AS serving_valid_until,
            clock_timestamp() AS database_time
       FROM hns_root_import_sessions AS session
       JOIN hns_root_import_activation_operations AS activation
         ON activation.root_import_session_id = session.root_import_session_id
       JOIN hns_dns_zone_activation_current AS dns
         ON dns.dns_zone_activation_id = activation.dns_zone_activation_id
       JOIN hns_dns_zone_activation_revisions AS revision
         ON revision.dns_zone_activation_id = dns.dns_zone_activation_id
        AND revision.dns_zone_activation_generation = dns.current_generation
       LEFT JOIN hns_authority_provision_jobs AS provision
         ON provision.root_import_session_id = session.root_import_session_id
        AND provision.state = 'completed'
      WHERE session.root_label = $1 AND dns.canonical_root = $1
        AND (session.root_import_session_id = $2
             OR ($2::text IS NULL AND session.status = 'activated'))
      ${lock ? "FOR NO KEY UPDATE OF session, dns" : ""}`,
    [rootLabel, sessionId],
  );
  const row = rows.rows[0];
  if (rows.rows.length !== 1 || row === undefined)
    return refuse("the root has no single activated session");
  const retainedZone = new Uint8Array(row.zone_bytes);
  if (sha256(retainedZone) !== row.zone_bytes_digest)
    refuse("the retained zone does not match its digest");
  const now = row.database_time.getTime();
  return {
    root_label: rootLabel,
    root_import_session_id: row.root_import_session_id,
    session_status: row.session_status,
    namespace_session_id: row.namespace_session_id,
    challenge_txt_value: row.challenge_txt_value,
    ownership_result_sha256: row.ownership_result_sha256,
    publish_plan_sha256: row.session_publish_plan_sha256,
    publish_plan_bytes: optionalBytes(row.publish_plan_bytes),
    session_expires_at: row.session_expires_at,
    provision_publish_plan_sha256: row.provision_publish_plan_sha256,
    provision_result_sha256: row.provision_result_sha256,
    provision_result_bytes: optionalBytes(row.provision_result_bytes),
    dns_zone_activation_id: row.dns_zone_activation_id,
    current_generation: Number(row.current_generation),
    retained_zone_bytes: retainedZone,
    retained_zone_bytes_sha256: row.zone_bytes_digest,
    dnssec_keyset_reference: row.dnssec_keyset_reference,
    dnssec_keyset_version: row.dnssec_keyset_version,
    gateway_deployment_reference: row.gateway_deployment_reference,
    gateway_certificate_spki_sha256: row.gateway_certificate_spki_sha256,
    stable_chain_delegation_snapshot_reference: row.stable_chain_delegation_snapshot_reference,
    open_renewal_jobs: Number(row.open_renewal_jobs),
    serving_valid_until: row.serving_valid_until?.toISOString() ?? null,
    serving_valid_for_seconds:
      row.serving_valid_until === null
        ? null
        : Math.floor((row.serving_valid_until.getTime() - now) / 1000),
    database_time: row.database_time.toISOString(),
  };
}

/**
 * The renewal observation request for the root's session, byte for byte what
 * `encode_hns_root_readiness_observation_request_v1` produces: canonical JSON
 * with the keys in order. Adoption observes the root exactly as a renewal
 * does, so it hands the observer the same request.
 */
export function hnsRootZoneAdoptionObservationRequestBytes(
  state: HnsRootZoneAdoptionState,
): Uint8Array {
  if (
    state.challenge_txt_value === null ||
    state.session_expires_at === null ||
    state.namespace_session_id === null ||
    state.ownership_result_sha256 === null ||
    state.provision_result_sha256 === null ||
    state.provision_publish_plan_sha256 === null ||
    state.publish_plan_sha256 !== state.provision_publish_plan_sha256
  )
    return refuse("the root's session does not hold what a renewal observation is bound to");
  return new TextEncoder().encode(
    JSON.stringify({
      challenge_txt_value: state.challenge_txt_value,
      expires_at: state.session_expires_at,
      namespace_session_id: state.namespace_session_id,
      ownership_result_sha256: state.ownership_result_sha256,
      provision_result_sha256: state.provision_result_sha256,
      publish_plan_sha256: state.provision_publish_plan_sha256,
      root_import_session_id: state.root_import_session_id,
      root_label: state.root_label,
      version: "pirate-hns-root-readiness-observation-request-v1",
    }),
  );
}

/** The activated root's state, read without locks in a read-only transaction. */
export async function readHnsRootZoneAdoptionState(
  client: Client,
  rootLabel: string,
): Promise<HnsRootZoneAdoptionState> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return await selectState(client, rootLabel, null, false);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

/**
 * Holds the session and DNS pointer rows while the provider change runs.
 * Policy is derived here from the retained bytes, intended change and provider
 * family facts read under the lock. Starting a departure is refused with an
 * open job or insufficient validity; recovery remains possible. The signal
 * aborts on loss of the database connection and thus the fence.

 */
export async function withHnsRootZoneAdoptionFence<A>(
  client: Client,
  input: {
    readonly root_label: string;
    readonly minimum_serving_validity_seconds: number;
    readonly change: "add" | "remove";
    /** Validated provider state read under the fence; this supplies facts, not policy. */
    readonly read_family: (
      state: HnsRootZoneAdoptionState,
      signal: AbortSignal,
    ) => Promise<"absent" | "partial" | "complete">;
  },
  change: (state: HnsRootZoneAdoptionState, signal: AbortSignal) => Promise<A>,
): Promise<A> {
  if (
    !Number.isSafeInteger(input.minimum_serving_validity_seconds) ||
    input.minimum_serving_validity_seconds < 3_600 ||
    input.minimum_serving_validity_seconds > 604_800
  )
    refuse("invalid minimum serving validity");
  const controller = new AbortController();
  const disconnected = () => controller.abort(new Error("HNS zone adoption fence was lost"));
  client.on("error", disconnected);
  client.on("end", disconnected);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout TO '10s'");
    const state = await selectState(client, input.root_label, null, true);
    const retained = hnsZoneHoldsWildcardAddressFamilyV1({
      root_label: state.root_label,
      zone_bytes: state.retained_zone_bytes,
    });
    const present = await input.read_family(state, controller.signal);
    if (
      !["absent", "partial", "complete"].includes(present) ||
      !["add", "remove"].includes(input.change)
    )
      refuse("invalid wildcard family state");
    // Only starting a departure is barred. Completing an interrupted change,
    // or restoring the retained shape, remains possible with a queued job.
    const startsDeparture =
      (input.change === "add") !== retained && present === (retained ? "complete" : "absent");
    if (startsDeparture) {
      if (state.open_renewal_jobs !== 0)
        refuse("a renewal job for the root's current generation is open");
      if (
        state.serving_valid_for_seconds === null ||
        state.serving_valid_for_seconds < input.minimum_serving_validity_seconds
      )
        refuse(
          "the root is too close to expiry for a change to be adopted before a renewal is scheduled",
        );
    }
    const result = await change(state, controller.signal);
    // A lost connection released the rows while the change was running.
    controller.signal.throwIfAborted();
    await client.query("SELECT 1");
    return result;
  } finally {
    client.off("error", disconnected);
    client.off("end", disconnected);
    await client.query("ROLLBACK").catch(() => undefined);
  }
}

export async function adoptHnsRootZone(
  client: Client,
  input: {
    readonly result_bytes: Uint8Array;
    /** The digest the operator reviewed; the observation must be these bytes. */
    readonly expected_result_sha256: string;
    /** The difference the operator intends; any other is refused. */
    readonly expected_delta: HnsZoneAdoptionDeltaKind;
    readonly mode: HnsZoneAdoptionMode;
    /** Fresh full observer result, read under the same database fence. */
    readonly observe_current: (state: HnsRootZoneAdoptionState) => Promise<Uint8Array>;
  },
): Promise<HnsZoneAdoptionReceipt> {
  if (!["dry-run", "rehearse", "commit"].includes(input.mode)) refuse("invalid adoption mode");
  const resultSha256 = sha256(input.result_bytes);
  if (
    !/^[0-9a-f]{64}$/u.test(input.expected_result_sha256) ||
    resultSha256 !== input.expected_result_sha256
  )
    refuse("the observation is not the one that was reviewed");
  const decoded = await decodeHnsRootImportReadinessResultV1(input.result_bytes).catch(() =>
    refuse("the observation is not a readiness result"),
  );
  const result = decoded.result;
  if (sha256(decoded.managed_zone_bytes) !== result.observed_zone_bytes_sha256)
    refuse("the observation's zone does not match its own digest");

  if (
    hnsZoneAdoptionSerialV1(result.root_label, decoded.managed_zone_bytes) !==
    result.powerdns_zone_serial
  )
    refuse("the observation serial disagrees with its zone bytes");

  const writing = input.mode !== "dry-run";
  await client.query(
    writing ? "BEGIN ISOLATION LEVEL SERIALIZABLE" : "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
  );
  let transactionOpen = true;
  try {
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    const state = await selectState(
      client,
      result.root_label,
      result.root_import_session_id,
      writing,
    );
    if (state.session_status !== "activated") refuse("the root's session is not activated");
    if (
      state.provision_publish_plan_sha256 === null ||
      state.provision_result_sha256 === null ||
      state.publish_plan_sha256 !== state.provision_publish_plan_sha256 ||
      result.namespace_session_id !== state.namespace_session_id ||
      result.ownership_result_sha256 !== state.ownership_result_sha256 ||
      result.publish_plan_sha256 !== state.publish_plan_sha256 ||
      result.provision_result_sha256 !== state.provision_result_sha256
    )
      refuse("the observation is not bound to the root's session and provision result");
    if (
      result.delegation_matches !== true ||
      result.ds_authenticates_zone !== true ||
      result.retained_zone_digest_matches !== true ||
      result.gateway_healthy !== true
    )
      refuse("the observation does not report a healthy authority");
    if (
      result.dnssec_keyset_reference !== state.dnssec_keyset_reference ||
      result.dnssec_keyset_version !== state.dnssec_keyset_version ||
      result.gateway_deployment_reference !== state.gateway_deployment_reference ||
      result.gateway_certificate_spki_sha256 !== state.gateway_certificate_spki_sha256 ||
      `hns-root-chain:${result.chain_resource_sha256}` !==
        state.stable_chain_delegation_snapshot_reference
    )
      refuse("the observation's keyset, gateway or chain reference is not the current revision's");
    const now = Date.parse(state.database_time);
    const observed = Date.parse(result.observed_at);
    const remaining = Math.floor((Date.parse(result.valid_until) - now) / 1000);
    if (
      !(observed <= now) ||
      !(now - observed <= MAXIMUM_OBSERVATION_AGE_SECONDS * 1_000) ||
      !(remaining >= 1 && remaining <= 604_800)
    )
      refuse("the observation is stale; observe the root again");
    const delta = requireHnsZoneAdoptionDeltaV1({
      root_label: result.root_label,
      retained_zone_bytes: state.retained_zone_bytes,
      observed_zone_bytes: decoded.managed_zone_bytes,
    });
    if (delta !== input.expected_delta)
      refuse(`the zone difference is ${delta}, not the one intended`);
    // DNS and its keys have no transaction shared with PostgreSQL. The
    // operator must retain exclusive authority-writer custody through commit.
    // Reobserve both authorities, keys, chain and gateway here; a serial alone
    // cannot identify content. The port uses state.database_time as its clock.
    const fresh = await decodeHnsRootImportReadinessResultV1(await input.observe_current(state));
    const stableFields = [
      "root_label",
      "root_import_session_id",
      "namespace_session_id",
      "ownership_result_sha256",
      "publish_plan_sha256",
      "provision_result_sha256",
      "observed_zone_bytes_sha256",
      "powerdns_zone_serial",
      "dnssec_keyset_reference",
      "dnssec_keyset_version",
      "gateway_deployment_reference",
      "gateway_certificate_spki_sha256",
      "chain_resource_sha256",
      "delegation_matches",
      "ds_authenticates_zone",
      "retained_zone_digest_matches",
      "gateway_healthy",
    ] as const;
    if (
      stableFields.some((field) => fresh.result[field] !== result[field]) ||
      sha256(fresh.managed_zone_bytes) !== result.observed_zone_bytes_sha256 ||
      hnsZoneAdoptionSerialV1(result.root_label, fresh.managed_zone_bytes) !==
        fresh.result.powerdns_zone_serial ||
      fresh.result.observed_at !== state.database_time
    )
      refuse("the authorities no longer serve the zone that was observed; observe the root again");
    const finished = await client.query<{ database_time: Date }>(
      "SELECT clock_timestamp() AS database_time",
    );
    const checkedAt = finished.rows[0]?.database_time.getTime();
    if (
      checkedAt === undefined ||
      checkedAt < now ||
      checkedAt - observed > MAXIMUM_OBSERVATION_AGE_SECONDS * 1_000 ||
      Date.parse(result.valid_until) <= checkedAt
    )
      refuse("the observation is stale; observe the root again");

    const receipt = (committed: boolean): HnsZoneAdoptionReceipt => ({
      mode: input.mode,
      committed,
      root_label: result.root_label,
      root_import_session_id: state.root_import_session_id,
      delta,
      result_sha256: resultSha256,
      previous_generation: state.current_generation,
      next_generation: state.current_generation + 1,
      previous_zone_bytes_sha256: state.retained_zone_bytes_sha256,
      next_zone_bytes_sha256: result.observed_zone_bytes_sha256,
      authority_inventory_version: result.authority_inventory_version,
      valid_until: result.valid_until,
      open_renewal_jobs: state.open_renewal_jobs,
      database_time: state.database_time,
    });
    if (!writing) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return receipt(false);
    }

    await promoteImportedHnsInventorySuccessor(
      client,
      input.result_bytes,
      resultSha256,
      "hns-zone-adoption",
    );
    const after = await client.query<{ generation: string; zone_bytes_digest: string }>(
      `SELECT dns.current_generation::text AS generation, revision.zone_bytes_digest
         FROM hns_dns_zone_activation_current AS dns
         JOIN hns_dns_zone_activation_revisions AS revision
           ON revision.dns_zone_activation_id = dns.dns_zone_activation_id
          AND revision.dns_zone_activation_generation = dns.current_generation
        WHERE dns.dns_zone_activation_id = $1`,
      [state.dns_zone_activation_id],
    );
    if (
      after.rows.length !== 1 ||
      Number(after.rows[0]?.generation) !== state.current_generation + 1 ||
      after.rows[0]?.zone_bytes_digest !== result.observed_zone_bytes_sha256
    )
      refuse("the successor did not become the current generation with the observed zone");
    // Exercise deferred pointer foreign keys before either rollback or commit.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    if (input.mode === "rehearse") {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return receipt(false);
    }
    transactionOpen = false;
    try {
      await client.query("COMMIT");
    } catch {
      throw new HnsZoneAdoptionCommitUnknown();
    }
    return receipt(true);
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
