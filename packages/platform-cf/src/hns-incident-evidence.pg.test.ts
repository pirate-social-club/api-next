import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  decodeHnsResourceV1,
  preflightEncodeHnsResourceV1,
} from "@pirate/application/namespace-ownership";
import { makeHsdRootResourceObserver } from "@pirate/platform-cf/namespace-ownership-hns-root-resource-observer";
import { Client } from "pg";
import { gatherHnsIncidentEvidenceV1 } from "../../../apps/hns-authority-provisioner/src/incident-evidence.ts";
import { makeHnsIncidentHsdReadsV1 } from "../../../apps/hns-authority-provisioner/src/incident-hsd.ts";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";

/**
 * Incident evidence against a live chain, read-only.
 *
 * This is the step that must be right before anything is authorized: which
 * transaction published what the name currently carries, whether those bytes
 * are the ones the owner was asked to publish, and whether the operation's own
 * authority is still there. Every read here is a read; nothing in this file
 * mutates a name, a zone, or an operation.
 *
 * Skips unless both a PostgreSQL URL and a reachable regtest node are present.
 */

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const nodeUrl = process.env.HSD_REGTEST_NODE_URL ?? "http://127.0.0.1:14037/";
const walletUrl = process.env.HSD_REGTEST_WALLET_URL ?? "http://127.0.0.1:14039/";
const apiKey = process.env.HSD_REGTEST_API_KEY ?? "controlled-progression";
const authorization = `Basic ${Buffer.from(`x:${apiKey}`).toString("base64")}`;

async function reachable(): Promise<boolean> {
  if (connectionString === undefined) return false;
  try {
    const response = await fetch(nodeUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ method: "getblockchaininfo", params: [] }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await response.json()) as { readonly result?: { readonly chain?: string } };
    return body.result?.chain === "regtest";
  } catch {
    return false;
  }
}

const suite = (await reachable()) ? describe : describe.skip;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { readonly result?: unknown; readonly error?: unknown };
  if (body.error !== null && body.error !== undefined) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}
const node = (method: string, params: readonly unknown[] = []) => rpc(nodeUrl, method, params);
const wallet = (method: string, params: readonly unknown[] = []) => rpc(walletUrl, method, params);

const sha256Hex = async (hex: string): Promise<string> => {
  const bytes = Uint8Array.from((hex.match(/../gu) ?? []).map((byte) => Number.parseInt(byte, 16)));
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

suite("HNS incident evidence against regtest and PostgreSQL", () => {
  test("the published transaction is attributed, and the covenant bytes decide the classification", async () => {
    const name = `incident${Date.now().toString(36)}`;
    const session = `session-${name}`;
    const address = (await wallet("getnewaddress", [])) as string;
    const mine = (count: number) => node("generatetoaddress", [count, address]);

    await mine(110);
    await wallet("sendopen", [name]);
    await mine(8);
    await wallet("sendbid", [name, 5, 10]);
    await mine(6);
    await wallet("sendreveal", []);
    await mine(12);

    const planned = [
      { type: "NS", ns: "ns1.pirate." },
      { type: "NS", ns: "ns2.pirate." },
      { type: "TXT", txt: [`pirate-verification=${name}`] },
    ] as const;
    const planDigest = (await preflightEncodeHnsResourceV1(planned as never)).sha256;
    await wallet("sendupdate", [name, { records: planned }]);
    await mine(1);
    const publishedHeight = ((await node("getblockchaininfo")) as { readonly blocks: number })
      .blocks;

    const observer = makeHsdRootResourceObserver(
      {
        rpc_url: nodeUrl,
        authorization,
        chain_network: "regtest",
        genesis_block_hash: (await node("getblockhash", [0])) as string,
        tree_interval_blocks: 5,
        safe_minimum_confirmations: 12,
        maximum_tip_age_seconds: 86_400,
        maximum_future_tip_seconds: 3_600,
      },
      fetch,
    );
    const reads = makeHnsIncidentHsdReadsV1({ rpc_url: nodeUrl, authorization });

    const schema = `hns_incident_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${quote(schema)}`);
      await admin.query(`SET search_path TO ${quote(schema)}`);
      for (const migration of await loadPostgresMigrations()) await admin.query(migration.sql);
      await admin.query(
        `INSERT INTO hns_root_import_lifecycle (
             root_import_session_id, root_label, phase, revision, generation,
             plan_exposed_at, publication_deadline_at, pending_reason,
             policy_name, policy_digest, plan_encoded_resource_sha256
           ) VALUES ($1,$2,'recovery_required',1,1,
             clock_timestamp() - interval '20 days', clock_timestamp() - interval '6 days',
             'publication_deadline_reached','hns_root_import_lifecycle_v1','incident',$3)`,
        [session, name, planDigest],
      );

      const ports = (zone: { zone_present: boolean; signing_keys_present: boolean } | null) => ({
        ...reads,
        observe_chain: observer,
        zone_availability: async () => zone,
        retained_plan: async () => {
          const row = await admin.query<Record<string, unknown>>(
            `SELECT root_label, generation, revision, plan_encoded_resource_sha256
                 FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
            [session],
          );
          const found = row.rows[0];
          if (found === undefined) return null;
          return {
            root_label: String(found.root_label),
            generation: Number(found.generation),
            revision: Number(found.revision),
            plan_encoded_sha256: found.plan_encoded_resource_sha256 as string | null,
            authority: {
              ns_names: ["ns1.pirate.", "ns2.pirate."],
              ds: [],
              challenge_txt_value: `pirate-verification=${name}`,
            },
          };
        },
        decode_resource: (hex: string) =>
          decodeHnsResourceV1(
            Uint8Array.from((hex.match(/../gu) ?? []).map((b) => Number.parseInt(b, 16))),
          ),
        sha256_hex: sha256Hex,
      });

      // Provider availability unknown: every chain fact is established and
      // the finding still refuses to support an action, because whether our
      // own authority survived was never read.
      const unknownZone = await gatherHnsIncidentEvidenceV1(session, ports(null) as never);
      expect(unknownZone?.finding.classification).toBe("insufficient_evidence");
      expect(unknownZone?.finding.reason).toBe("provider_availability_unknown");

      const report = await gatherHnsIncidentEvidenceV1(
        session,
        ports({ zone_present: true, signing_keys_present: true }) as never,
      );
      expect(report).not.toBeNull();
      const inclusion = report?.evidence.inclusion;
      expect(inclusion).not.toBeNull();
      // The transaction that published the resource is attributed to its own
      // block, not to the height the name was opened at.
      expect(inclusion?.block_height).toBe(publishedHeight);
      // A name's first data push is a REGISTER covenant and every later one is
      // an UPDATE. Both carry the resource, and the action is recorded as
      // evidence rather than used as a gate.
      expect(["REGISTER", "UPDATE"]).toContain(inclusion?.covenant_action ?? "");
      // And the covenant's own bytes are what the plan is compared against.
      expect(inclusion?.covenant_resource_sha256).toBe(planDigest);
      expect(report?.finding.classification).toBe("matching_authority_available");
      expect(report?.finding.reason).toBe("published_resource_matches_plan");
      expect(report?.finding.supported_action).toBe("resume");

      // The owner publishes something else. The same reads now attribute a
      // different transaction in a different block, the covenant bytes no
      // longer match the plan, and nothing about our authority is referenced.
      await wallet("sendupdate", [name, { records: [{ type: "TXT", txt: ["moved on"] }] }]);
      await mine(1);
      const replacedHeight = ((await node("getblockchaininfo")) as { readonly blocks: number })
        .blocks;
      const conflicting = await gatherHnsIncidentEvidenceV1(
        session,
        ports({ zone_present: true, signing_keys_present: true }) as never,
      );
      expect(conflicting?.evidence.inclusion?.block_height).toBe(replacedHeight);
      expect(conflicting?.evidence.inclusion?.covenant_resource_sha256).not.toBe(planDigest);
      expect(conflicting?.finding.classification).toBe("conflicting_publication");
      expect(conflicting?.finding.supported_action).toBeNull();
      // A different reading is a different evidence reference, so the two
      // cannot replay as one another.
      expect(conflicting?.evidence_ref).not.toBe(report?.evidence_ref);

      // Recording the finding is the only write, and it writes evidence, not
      // authority: the operation is untouched by it.
      const recorded = await admin.query<Record<string, unknown>>(
        `SELECT * FROM record_hns_root_import_recovery_finding_v1(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          session,
          1,
          conflicting?.evidence_ref,
          conflicting?.finding.classification,
          conflicting?.finding.reason,
          conflicting?.finding.supported_action,
          conflicting?.evidence.inclusion?.txid,
          conflicting?.evidence.inclusion?.block_height,
          conflicting?.evidence.inclusion?.covenant_resource_sha256,
          planDigest,
          null,
          null,
          true,
          true,
        ],
      );
      expect(recorded.rows[0]?.outcome).toBe("recorded");
      const after = await admin.query<Record<string, unknown>>(
        "SELECT phase, revision FROM hns_root_import_lifecycle WHERE root_import_session_id=$1",
        [session],
      );
      expect(after.rows[0]).toMatchObject({ phase: "recovery_required", revision: "1" });

      console.log(
        JSON.stringify({
          name,
          published_height: publishedHeight,
          replaced_height: replacedHeight,
          classification: conflicting?.finding.classification,
        }),
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 900_000);
});
