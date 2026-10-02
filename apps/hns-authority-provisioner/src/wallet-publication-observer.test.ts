import { expect, test } from "bun:test";
import type { HnsIncidentEvidenceReportV1 } from "./incident-evidence.ts";
import {
  retainWalletPublicationConfirmation,
  walletPublicationIsConfirmed,
} from "./wallet-publication-observer.ts";

function report(): HnsIncidentEvidenceReportV1 {
  const anchor = {
    network: "regtest",
    genesis_block_hash: "a".repeat(64),
    height: 156,
    best_block_hash: "b".repeat(64),
    median_time_past_epoch_seconds: 1,
    header_time_epoch_seconds: 1,
    confirmations: 1,
  };
  const observation = {
    view: "current" as const,
    network: "regtest",
    genesis_block_hash: "a".repeat(64),
    anchor,
    tip_height: 156,
    update_inclusion_height: 100,
    commitment: null,
    observed_at_epoch_ms: Date.now(),
    records: [],
    resource_sha256: "c".repeat(64),
  };
  return {
    root_import_session_id: "session",
    root_label: "harbor",
    generation: 1,
    revision: 4,
    recordable: true,
    evidence_ref: "qualified-fixture",
    finding: {
      classification: "matching_authority_available",
      reason: "published_resource_matches_plan",
      inspected_views: ["current", "safe"],
      supported_action: "resume",
    },
    evidence: {
      inclusion: {
        txid: "d".repeat(64),
        output_index: 0,
        block_hash: "e".repeat(64),
        block_height: 100,
        confirmations: 57,
        covenant_action: "UPDATE",
        covenant_resource_sha256: "f".repeat(64),
      },
      decoded_resource: [],
      retained_plan_encoded_sha256: "f".repeat(64),
      retained_authority: { ns_names: [], ds: [], challenge_txt_value: null },
      current: { kind: "observed", observation },
      safe: {
        kind: "observed",
        observation: {
          ...observation,
          view: "safe",
          commitment: {
            selection_basis: "hsd_getsaferoot_compatible",
            commitment_height: 144,
            commitment_block_hash: "b".repeat(64),
            commitment_tree_root: "a".repeat(64),
            tip_height: 156,
            tree_interval_blocks: 36,
            minimum_confirmations: 12,
          },
        },
      },
      zone: { zone_present: true, signing_keys_present: true },
    },
  };
}

test("qualifies safe UPDATE inclusion and retains its finding before resolving a receipt", async () => {
  const input = report();
  expect(walletPublicationIsConfirmed(input)).toBe(true);
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  await retainWalletPublicationConfirmation(
    async <Row>(text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return { rows: [{ outcome: "recorded", recovery_finding_id: "42" }] as Row[] };
    },
    input,
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toContain("d".repeat(64));
  expect(calls[1]).toEqual({
    text: "SELECT observe_hns_wallet_publication_v1($1)",
    values: ["42"],
  });
});

for (const gap of [
  "missing_tx",
  "unconfirmed",
  "after_safe",
  "different_resource",
  "moving_chain",
  "wrong_network",
  "unavailable",
  "no_lifecycle",
] as const) {
  test(`${gap} cannot resolve a dispatch attempt`, async () => {
    const input = report();
    const evidence = input.evidence;
    const invalid: HnsIncidentEvidenceReportV1 = {
      ...input,
      ...(gap === "no_lifecycle" ? { recordable: false } : {}),
      evidence: {
        ...evidence,
        ...(gap === "missing_tx" ? { inclusion: null } : {}),
        ...(gap === "unconfirmed"
          ? { inclusion: { ...evidence.inclusion!, confirmations: 0 } }
          : {}),
        ...(gap === "after_safe"
          ? { inclusion: { ...evidence.inclusion!, block_height: 145 } }
          : {}),
        ...(gap === "different_resource"
          ? { inclusion: { ...evidence.inclusion!, covenant_resource_sha256: "0".repeat(64) } }
          : {}),
        ...(gap === "unavailable"
          ? { safe: { kind: "unavailable", classification: "node_unavailable" } as const }
          : {}),
        ...(gap === "moving_chain" || gap === "wrong_network"
          ? {
              current: {
                kind: "observed" as const,
                observation: {
                  ...(evidence.current!.kind === "observed"
                    ? evidence.current!.observation
                    : (() => {
                        throw new Error("fixture");
                      })()),
                  ...(gap === "moving_chain"
                    ? { resource_sha256: "0".repeat(64) }
                    : { network: "other" }),
                },
              },
            }
          : {}),
      },
    };
    let writes = 0;
    await retainWalletPublicationConfirmation(async () => {
      writes++;
      return { rows: [] };
    }, invalid);
    expect(writes).toBe(0);
  });
}
