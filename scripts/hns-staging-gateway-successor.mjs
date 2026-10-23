import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeHnsAppHostTransitionDocumentV1,
  encodeHnsDnsHealthDocumentV1,
  encodeHnsDnsZonePersistenceDocumentV1,
  HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
  prepareHnsDnsZoneActivationDocumentV1,
} from "../packages/application/src/hns-host-persistence.ts";
import { decodeHnsAuthorityInventoryBytes } from "../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import { promoteHnsAuthoritySuccessorInTransaction } from "../packages/platform-cf/src/hns-authority-successor-promotion.ts";
import {
  requireHnsGatewayRotationFence,
  requireHnsReviewedGatewayRotation,
} from "../packages/platform-cf/src/hns-gateway-rotation.ts";
import { openContinuityDatabase, readContinuityState } from "./hns-continuity/database.mjs";

const roots = ["8s28", "a18n"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const bytes = (hex) => Buffer.from(hex, "hex");
const digest = (value) => sha(JSON.stringify(value));
const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
const reference = (manifest) => `hns-community-app-handle-gateway-sha256:${sha(manifest)}`;
const stateIdentity = ({ database_time: _, ...state }) => digest(state);

function manifestPair(previous, next) {
  const before = JSON.parse(previous),
    after = JSON.parse(next);
  fail(previous.length <= 65536 && next.length <= 65536, "Manifest size invalid");
  fail(
    JSON.stringify(before) === previous && JSON.stringify(after) === next,
    "Manifest is not canonical",
  );
  fail(
    before.schema === "pirate-hns-community-app-handle-gateway-staging-public-v1" &&
      before.mode === "staging-public-tls" &&
      before.public_tls_listener === "94.103.168.209:443" &&
      before.solid_origin === "https://hns-community-ingress-staging.pirate.sc",
    "Not the staging gateway",
  );
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  fail(
    changed.length === 1 &&
      changed[0] === "solid_ingress_composition_reference" &&
      /^solid-hns-ingress-sha256:[0-9a-f]{64}$/u.test(after.solid_ingress_composition_reference),
    "Only the Solid ingress fingerprint may change",
  );
  return { before, after };
}

/** A frozen, short execution window keeps every emitted document byte reviewable.
 * Existing DNS health is inherited, not described as newly observed DNS proof. */
export async function prepareStagingGatewaySuccessor({
  states,
  previousManifest,
  nextManifest,
  readiness,
  sourceCommit,
  executeBy,
}) {
  const { after } = manifestPair(previousManifest, nextManifest);
  fail(/^[0-9a-f]{40}$/u.test(sourceCommit), "Source commit invalid");
  fail(
    JSON.stringify(states.map((state) => state.dns.canonical_root)) === JSON.stringify(roots),
    "Review both staging roots in order",
  );
  const observed = Math.max(...states.map((state) => Date.parse(state.database_time)));
  const deadline = Date.parse(executeBy);
  fail(
    Number.isFinite(deadline) && deadline > observed && deadline <= observed + 900000,
    "Execution window must be at most fifteen minutes",
  );
  const rotation = await requireHnsReviewedGatewayRotation({
    rotation: readiness,
    previousGatewayReference: reference(previousManifest),
    certificateSpki: after.gateway_certificate_spki_sha256,
    observedAt: new Date(observed).toISOString(),
    environment: "staging",
  });
  fail(rotation.manifest_json === nextManifest, "Readiness names another manifest");
  const entries = [];
  for (const state of states) {
    const { dns, app, sale, health } = state;
    const inventoryBytes = bytes(state.inventory.bytes_hex);
    const decoded = await decodeHnsAuthorityInventoryBytes(inventoryBytes);
    const inventory = decoded.inventory;
    fail(
      inventory.environment === "staging" &&
        decoded.inventory_digest === dns.pirate_dns_authority_inventory_digest &&
        inventory.authority_inventory_reference === dns.pirate_dns_authority_inventory_reference &&
        inventory.authority_inventory_version === dns.pirate_dns_authority_inventory_version &&
        new Date(state.inventory.expires_at).toISOString() === inventory.expires_at,
      "Retained staging inventory mismatch",
    );
    fail(
      dns.gateway_deployment_reference === reference(previousManifest) &&
        dns.gateway_certificate_spki_sha256 === after.gateway_certificate_spki_sha256 &&
        sha(bytes(dns.zone_hex)) === dns.zone_bytes_digest,
      "Retained gateway or zone identity mismatch",
    );
    fail(
      dns.status === "active" &&
        app.status === "active" &&
        sale.status === "active" &&
        app.gateway_deployment_reference === dns.gateway_deployment_reference &&
        app.dns_zone_activation_id === dns.dns_zone_activation_id &&
        sale.dns_zone_activation_id === dns.dns_zone_activation_id &&
        Number(app.dns_zone_activation_generation) === Number(dns.dns_zone_activation_generation) &&
        Number(sale.dns_zone_activation_generation) === Number(dns.dns_zone_activation_generation),
      "Inactive or mixed predecessor",
    );
    fail(
      health.delegation_matches &&
        health.ds_authenticates_zone &&
        health.retained_zone_digest_matches &&
        health.gateway_healthy &&
        health.observed_zone_bytes_digest === dns.zone_bytes_digest &&
        health.observed_dnssec_keyset_reference === dns.dnssec_keyset_reference &&
        health.observed_dnssec_keyset_version === dns.dnssec_keyset_version &&
        health.observed_gateway_deployment_reference === dns.gateway_deployment_reference &&
        health.observed_gateway_certificate_spki_sha256 === dns.gateway_certificate_spki_sha256 &&
        health.stable_chain_delegation_snapshot_reference ===
          dns.stable_chain_delegation_snapshot_reference &&
        health.stable_chain_delegation_snapshot_digest ===
          dns.stable_chain_delegation_snapshot_digest,
      "Retained health facts do not match the predecessor",
    );
    const cap = Math.min(Date.parse(health.valid_until), Date.parse(inventory.expires_at));
    const ttl = Math.floor((cap - deadline) / 1000) - 5;
    fail(
      Number.isSafeInteger(ttl) &&
        ttl > 0 &&
        ttl <= 604800 &&
        Date.parse(health.checked_at) <= observed,
      "Retained evidence cannot cover the execution window",
    );
    const generation = Number(dns.dns_zone_activation_generation) + 1;
    fail(
      Number.isSafeInteger(generation) &&
        Number.isSafeInteger(state.successor_health_generation) &&
        state.successor_health_generation >= 0,
      "Invalid generation fence",
    );
    const root = dns.canonical_root;
    const successorId = digest([
      sourceCommit,
      root,
      stateIdentity(state),
      reference(nextManifest),
      executeBy,
    ]);
    const operation = (kind) => ({
      operation_id: `staging-gateway:${kind}:${successorId}`,
      idempotency_key: `staging-gateway:${kind}:${successorId}`,
      request_hash: successorId,
    });
    const nextDns = await prepareHnsDnsZoneActivationDocumentV1({
      payload: {
        version: HNS_DNS_ZONE_ACTIVATION_DOCUMENT_VERSION,
        dns_zone_activation_id: dns.dns_zone_activation_id,
        canonical_root: root,
        dns_authority: [dns.dns_authority_kind, dns.dns_authority_reference, generation],
        pirate_dns_authority_inventory: [
          dns.pirate_dns_authority_inventory_reference,
          dns.pirate_dns_authority_inventory_version,
          dns.pirate_dns_authority_inventory_digest,
        ],
        zone_revision: Number(dns.zone_revision) + 1,
        dnssec_keyset: [dns.dnssec_keyset_reference, dns.dnssec_keyset_version],
        gateway: [reference(nextManifest), dns.gateway_certificate_spki_sha256],
        stable_chain_delegation_snapshot: [
          dns.stable_chain_delegation_snapshot_reference,
          dns.stable_chain_delegation_snapshot_digest,
        ],
      },
      zone_bytes: bytes(dns.zone_hex),
    });
    entries.push({
      root,
      predecessor: state,
      predecessor_sha256: stateIdentity(state),
      successor_id: successorId,
      inherited_health_checked_at: new Date(health.checked_at).toISOString(),
      health_deadline: new Date(cap).toISOString(),
      generations: {
        dns_activation_generation: generation,
        app_host_activation_generation: Number(app.app_host_activation_generation) + 1,
        health_generation: state.successor_health_generation + 1,
      },
      dns_hex: Buffer.from(encodeHnsDnsZonePersistenceDocumentV1(nextDns)).toString("hex"),
      app_hex: Buffer.from(
        encodeHnsAppHostTransitionDocumentV1({
          ...operation("app"),
          app_host_activation_id: app.app_host_activation_id,
          expected_activation_generation: Number(app.app_host_activation_generation),
          target_status: "active",
          reason_code: "canonical-authority",
        }),
      ).toString("hex"),
      health_hex: Buffer.from(
        encodeHnsDnsHealthDocumentV1({
          ...operation("health"),
          dns_zone_activation_id: dns.dns_zone_activation_id,
          activation_generation: generation,
          expected_health_generation: state.successor_health_generation,
          stable_chain_delegation_snapshot_reference:
            dns.stable_chain_delegation_snapshot_reference,
          stable_chain_delegation_snapshot_digest: dns.stable_chain_delegation_snapshot_digest,
          observed_zone_bytes_digest: dns.zone_bytes_digest,
          observed_dnssec_keyset_reference: dns.dnssec_keyset_reference,
          observed_dnssec_keyset_version: dns.dnssec_keyset_version,
          observed_gateway_deployment_reference: reference(nextManifest),
          observed_gateway_certificate_spki_sha256: dns.gateway_certificate_spki_sha256,
          delegation_matches: true,
          ds_authenticates_zone: true,
          retained_zone_digest_matches: true,
          gateway_healthy: true,
          valid_for_seconds: ttl,
        }),
      ).toString("hex"),
    });
  }
  return {
    schema: "pirate-staging-gateway-fingerprint-successor-v1",
    source_commit: sourceCommit,
    execute_by: executeBy,
    previous_manifest: previousManifest,
    next_manifest: nextManifest,
    readiness: rotation,
    entries,
  };
}

async function requireRootSet(client, gateway) {
  const result = await client.query(
    `SELECT c.canonical_root FROM hns_dns_zone_activation_current c
    JOIN hns_dns_zone_activation_revisions r ON r.dns_zone_activation_id=c.dns_zone_activation_id
    AND r.dns_zone_activation_generation=c.current_generation WHERE r.gateway_deployment_reference=$1 ORDER BY c.canonical_root`,
    [gateway],
  );
  fail(
    JSON.stringify(result.rows.map((row) => row.canonical_root)) === JSON.stringify(roots),
    "Gateway root set changed",
  );
}

/** Both roots commit or roll back together. No retry follows an uncertain COMMIT. */
export async function applyStagingGatewaySuccessor({
  client,
  plan,
  confirmedSha256,
  mode = "preflight",
}) {
  fail(
    ["preflight", "rehearse", "commit"].includes(mode) && digest(plan) === confirmedSha256,
    "Unreviewed plan or mode",
  );
  const rebuilt = await prepareStagingGatewaySuccessor({
    states: plan.entries.map((entry) => entry.predecessor),
    previousManifest: plan.previous_manifest,
    nextManifest: plan.next_manifest,
    readiness: plan.readiness,
    sourceCommit: plan.source_commit,
    executeBy: plan.execute_by,
  });
  fail(digest(rebuilt) === confirmedSha256, "Plan does not reproduce exactly");
  let open = false;
  try {
    await client.query(
      `BEGIN ISOLATION LEVEL SERIALIZABLE${mode === "preflight" ? " READ ONLY" : ""}`,
    );
    open = true;
    await client.query("SET LOCAL search_path TO api_next, public");
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '20s'");
    await requireRootSet(client, reference(plan.previous_manifest));
    for (const entry of plan.entries) {
      if (mode !== "preflight") {
        const locked = await client.query(
          `SELECT dns.current_generation FROM hns_dns_zone_activation_current dns
          JOIN hns_community_app_host_activation_current app ON app.normalized_host='app.'||dns.canonical_root
          JOIN community_handle_sale_namespace_activation_current sale ON sale.canonical_root=dns.canonical_root
          WHERE dns.canonical_root=$1 FOR UPDATE OF dns,app,sale`,
          [entry.root],
        );
        fail(locked.rows.length === 1, "Root selector lock unavailable");
      }
      const current = await readContinuityState(client, entry.root);
      fail(
        stateIdentity(current) === entry.predecessor_sha256,
        "Predecessor changed; prepare again",
      );
      fail(
        Date.parse(current.database_time) <= Date.parse(plan.execute_by),
        "Execution window elapsed",
      );
      await requireHnsGatewayRotationFence({
        client,
        dnsActivationId: current.dns.dns_zone_activation_id,
        successorGeneration: entry.generations.dns_activation_generation,
        successorGatewayReference: reference(plan.next_manifest),
        certificateSpki: current.dns.gateway_certificate_spki_sha256,
        rotation: {
          reviewed: plan.readiness,
          previousHealthGeneration: Number(current.health.health_generation),
        },
      });
      const s = current.sale,
        d = current.dns;
      const dependency = await client.query(
        "SELECT * FROM current_hns_sale_namespace_dependency_v1($1,$2,$3,$4,$5,clock_timestamp())",
        [
          s.community_id,
          s.namespace_authority_reference,
          Number(s.namespace_authority_generation),
          d.dns_zone_activation_id,
          Number(d.dns_zone_activation_generation),
        ],
      );
      fail(
        dependency.rows.length === 1 &&
          dependency.rows[0].namespace_authority_current &&
          dependency.rows[0].dns_zone_current &&
          dependency.rows[0].dns_delegation_current,
        "Current namespace authority unavailable",
      );
    }
    const results = [];
    if (mode !== "preflight")
      for (const entry of plan.entries) {
        const state = entry.predecessor;
        const result = await promoteHnsAuthoritySuccessorInTransaction({
          client,
          inventoryRegistryReference: state.inventory.registry_reference,
          authorityInventoryBytes: bytes(state.inventory.bytes_hex),
          dnsActivationBytes: bytes(entry.dns_hex),
          appActivationBytes: bytes(entry.app_hex),
          healthObservationBytes: bytes(entry.health_hex),
          successorId: entry.successor_id,
          gatewayRotation: {
            reviewed: plan.readiness,
            previousHealthGeneration: Number(state.health.health_generation),
          },
          rootLabel: entry.root,
          generations: entry.generations,
          sale: state.sale,
        });
        const after = await readContinuityState(client, entry.root);
        for (const key of [
          "community_id",
          "canonical_root",
          "normalized_host",
          "route_binding_id",
          "route_authority_kind",
          "route_authority_reference",
          "route_authority_generation",
        ]) {
          fail(
            after.app[key] === state.app[key],
            "Successor changed unrelated app route authority",
          );
        }
        fail(
          after.app.gateway_deployment_reference === reference(plan.next_manifest),
          "Successor app gateway mismatch",
        );
        fail(
          Date.parse(after.health.valid_until) <= Date.parse(entry.health_deadline) &&
            Date.parse(after.database_time) <= Date.parse(plan.execute_by),
          "Successor would extend evidence or exceed execution window",
        );
        results.push({ root: entry.root, ...result, health_valid_until: after.health.valid_until });
      }
    if (mode !== "preflight") await requireRootSet(client, reference(plan.next_manifest));
    if (mode === "commit") {
      open = false;
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
      open = false;
    }
    return { mode, committed: mode === "commit", plan_sha256: confirmedSha256, results };
  } finally {
    if (open) await client.query("ROLLBACK");
  }
}

async function readJson(path) {
  fail(isAbsolute(path), "Use absolute evidence paths");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    fail(bytesRead > 0 && bytesRead < buffer.length, "Evidence size invalid");
    return JSON.parse(buffer.subarray(0, bytesRead).toString());
  } finally {
    await file.close();
  }
}

export async function main(args = Bun.argv.slice(2)) {
  const [mode, inputPath, confirmedSha256] = args;
  fail(
    ["prepare", "preflight", "rehearse", "commit"].includes(mode) &&
      args.length === (mode === "prepare" ? 2 : 3),
    "Usage: prepare /absolute/input.json | preflight|rehearse|commit /absolute/plan.json SHA256",
  );
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
  const tracked = Bun.spawnSync(
    ["git", "cat-file", "-e", "HEAD:scripts/hns-staging-gateway-successor.mjs"],
    { cwd },
  );
  fail(
    head.exitCode === 0 &&
      tracked.exitCode === 0 &&
      status.exitCode === 0 &&
      status.stdout.length === 0,
    "Use clean reviewed source",
  );
  const source = head.stdout.toString().trim();
  const input = await readJson(inputPath);
  const client = openContinuityDatabase(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL);
  await client.connect();
  try {
    if (mode !== "prepare") {
      fail(input.source_commit === source, "Plan source differs from checkout");
      return await applyStagingGatewaySuccessor({ client, plan: input, confirmedSha256, mode });
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let states;
    try {
      await client.query("SET LOCAL search_path TO api_next, public");
      await client.query("SET LOCAL statement_timeout TO '10s'");
      await requireRootSet(client, reference(input.previousManifest));
      states = [];
      for (const root of roots) states.push(await readContinuityState(client, root));
    } finally {
      await client.query("ROLLBACK");
    }
    const plan = await prepareStagingGatewaySuccessor({ ...input, states, sourceCommit: source });
    fail(isAbsolute(input.outputPath), "Plan output path must be absolute");
    await writeFile(input.outputPath, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    return { mode, plan_sha256: digest(plan), execute_by: plan.execute_by };
  } finally {
    await client.end();
  }
}

if (import.meta.main)
  await main()
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch(() => {
      console.error(
        "Staging gateway successor refused. Reconcile current generations before retrying any attempted commit. Credential-bearing errors are suppressed.",
      );
      process.exitCode = 1;
    });
