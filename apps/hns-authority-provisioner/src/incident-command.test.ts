import { describe, expect, test } from "bun:test";
import {
  collectMissingIncidentConfiguration,
  formatHnsIncidentReportV1,
  parseHnsIncidentCommandArgumentsV1,
  resolveHnsIncidentSessionV1,
  runHnsIncidentReportCommandV1,
} from "./incident-command.ts";
import type { HnsIncidentEvidencePortsV1 } from "./incident-evidence.ts";

/**
 * The read-only incident command: argument and session resolution, explicit
 * configuration prerequisites, and the classification it emits when a
 * provider read cannot resolve the publishing transaction.
 */

const completeConfiguration: Record<string, string> = {
  CONTROL_PLANE_POSTGRES_URL: "postgres://postgres:postgres@127.0.0.1:5472/postgres",
  HNS_AUTHORITY_HSD_RPC_URL: "http://127.0.0.1:14037/",
  HNS_AUTHORITY_HSD_AUTHORIZATION: "Basic dGVzdDp0ZXN0",
  HNS_AUTHORITY_CHAIN_NETWORK: "regtest",
  HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: "0".repeat(63) + "1",
  HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "36",
  HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
  HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "600",
  HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: "60",
  HNS_AUTHORITY_PDNS_API_URL: "http://127.0.0.1:8081/",
  HNS_AUTHORITY_PDNS_API_KEY: "pdns-test",
  HNS_AUTHORITY_PDNS_SERVER_ID: "localhost",
};

const observedCurrent = {
  kind: "observed",
  observation: {
    view: "current",
    network: "main",
    genesis_block_hash: "0".repeat(63) + "1",
    anchor: {
      network: "main",
      genesis_block_hash: "0".repeat(63) + "1",
      height: 812_345,
      best_block_hash: "aa".repeat(32),
      median_time_past_epoch_seconds: 1_770_000_000,
      header_time_epoch_seconds: 1_770_000_030,
      confirmations: 1,
    },
    tip_height: 812_345,
    update_inclusion_height: 800_000,
    commitment: null,
    observed_at_epoch_ms: 1_770_000_060_000,
    records: [],
    resource_sha256: "1".repeat(64),
  },
};

/** A provider whose transaction index is absent: the name is readable, the publication is not. */
const portsWithoutTransactionIndexing: HnsIncidentEvidencePortsV1 = {
  name_state: async () => ({
    owner_txid: "ab".repeat(32),
    owner_index: 0,
    resource_hex: "01",
  }),
  transaction: async () => null,
  block_height: async () => null,
  observe_chain: (async () => observedCurrent) as never,
  zone_availability: async () => ({ zone_present: true, signing_keys_present: true }),
  retained_plan: async () => ({
    root_label: "incidentroot",
    generation: 1,
    revision: 1,
    plan_encoded_sha256: "2".repeat(64),
    authority: { ns_names: ["ns1.pirate."], ds: [], challenge_txt_value: null },
    lifecycle_present: true,
  }),
  decode_resource: () => [],
  sha256_hex: async () => "3".repeat(64),
};

describe("incident command arguments", () => {
  test("accepts an exact session id", () => {
    expect(parseHnsIncidentCommandArgumentsV1(["--session", "session-1"])).toEqual({
      kind: "session",
      sessionId: "session-1",
    });
  });

  test("accepts community plus root label", () => {
    expect(
      parseHnsIncidentCommandArgumentsV1(["--community", "community-1", "--root", "example"]),
    ).toEqual({ kind: "community_root", communityId: "community-1", rootLabel: "example" });
  });

  test("refuses ambiguous or incomplete argument sets", () => {
    expect(() => parseHnsIncidentCommandArgumentsV1([])).toThrow(/arguments are invalid/u);
    expect(() => parseHnsIncidentCommandArgumentsV1(["--session"])).toThrow(
      /arguments are invalid/u,
    );
    expect(() =>
      parseHnsIncidentCommandArgumentsV1(["--community", "community-1", "--root"]),
    ).toThrow(/arguments are invalid/u);
    expect(() => parseHnsIncidentCommandArgumentsV1(["--session", "a", "--extra", "b"])).toThrow(
      /arguments are invalid/u,
    );
  });
});

describe("incident session resolution", () => {
  test("a session id is used as given", async () => {
    expect(
      await resolveHnsIncidentSessionV1(
        async () => {
          throw new Error("no query expected");
        },
        { kind: "session", sessionId: "exact" },
      ),
    ).toEqual({ outcome: "resolved", sessionId: "exact" });
  });

  test("community plus root with no session reports absence", async () => {
    expect(
      await resolveHnsIncidentSessionV1((async () => ({ rows: [] })) as never, {
        kind: "community_root",
        communityId: "c",
        rootLabel: "r",
      }),
    ).toEqual({ outcome: "none" });
  });

  test("several sessions for one root are listed, never chosen", async () => {
    const resolution = await resolveHnsIncidentSessionV1(
      (async () => ({
        rows: [
          { root_import_session_id: "newer", status: "failed", created_at: "2026-09-10" },
          { root_import_session_id: "older", status: "activated", created_at: "2026-09-01" },
        ],
      })) as never,
      { kind: "community_root", communityId: "c", rootLabel: "r" },
    );
    expect(resolution.outcome).toBe("ambiguous");
    if (resolution.outcome !== "ambiguous") throw new Error("expected ambiguity");
    expect(resolution.candidates.map((candidate) => candidate.root_import_session_id)).toEqual([
      "newer",
      "older",
    ]);
  });
});

describe("incident command prerequisites and classification", () => {
  test("lists every missing configuration name at once", () => {
    const missing = collectMissingIncidentConfiguration({});
    expect(missing.length).toBe(12);
    expect(missing).toContain("CONTROL_PLANE_POSTGRES_URL");
    expect(collectMissingIncidentConfiguration(completeConfiguration)).toEqual([]);
  });

  test("reports configuration by name instead of failing generically", async () => {
    const lines: string[] = [];
    const code = await runHnsIncidentReportCommandV1(["--session", "s"], {
      env: { ...completeConfiguration, HNS_AUTHORITY_PDNS_API_KEY: undefined },
      query: async () => ({ rows: [] }),
      fetch: (async () => {
        throw new Error("no fetch expected");
      }) as never,
      write: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(output.outcome).toBe("configuration_missing");
    expect(output.missing).toEqual(["HNS_AUTHORITY_PDNS_API_KEY"]);
  });

  test("an unresolvable transaction is insufficient evidence, not a negative finding", async () => {
    const lines: string[] = [];
    const code = await runHnsIncidentReportCommandV1(
      ["--session", "session-1"],
      {
        env: completeConfiguration,
        query: async () => ({ rows: [] }),
        fetch: (async () => {
          throw new Error("no fetch expected");
        }) as never,
        write: (line) => lines.push(line),
      },
      () => portsWithoutTransactionIndexing,
    );
    expect(code).toBe(0);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(output.classification).toBe("insufficient_evidence");
    expect(output.reason).toBe("inclusion_unresolved");
    expect(output.supported_action).toBeNull();
    expect(output.recordable).toBe(true);
    expect(output.unresolved_evidence).toContain("transaction_inclusion");
  });

  test("an ambiguous root reports its candidates", async () => {
    const lines: string[] = [];
    const code = await runHnsIncidentReportCommandV1(
      ["--community", "community-1", "--root", "example"],
      {
        env: completeConfiguration,
        query: (async () => ({
          rows: [
            { root_import_session_id: "newer", status: "failed", created_at: "2026-09-10" },
            { root_import_session_id: "older", status: "activated", created_at: "2026-09-01" },
          ],
        })) as never,
        fetch: (async () => {
          throw new Error("no fetch expected");
        }) as never,
        write: (line) => lines.push(line),
      },
      () => portsWithoutTransactionIndexing,
    );
    expect(code).toBe(1);
    const output = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(output.outcome).toBe("session_ambiguous");
    expect(output.candidates).toHaveLength(2);
  });
});

describe("incident report formatting", () => {
  test("names the retained plan gap when the operation predates the lifecycle table", () => {
    const formatted = formatHnsIncidentReportV1({
      root_import_session_id: "s",
      root_label: "r",
      generation: 1,
      revision: 1,
      recordable: false,
      evidence_ref: "evidence-ref",
      finding: {
        classification: "insufficient_evidence",
        reason: "retained_plan_digest_unknown",
        inspected_views: [],
        supported_action: null,
      },
      evidence: {
        inclusion: null,
        decoded_resource: null,
        retained_plan_encoded_sha256: null,
        retained_authority: null,
        current: null,
        safe: null,
        zone: null,
      },
    } as never);
    expect(formatted.recordable).toBe(false);
    expect(formatted.unresolved_evidence).toEqual([
      "retained_plan_digest",
      "retained_authority",
      "current_view",
      "safe_view",
      "provider_availability",
      "transaction_inclusion",
      "decoded_resource",
    ]);
  });
});
