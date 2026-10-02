import type { HnsChainObservationResultV1 } from "@pirate/application/namespace-ownership";
import { Client } from "pg";
import { makeHnsIncidentPortsFromConfigurationV1 } from "./incident-command.ts";
import {
  gatherHnsIncidentEvidenceV1,
  type HnsIncidentEvidenceReportV1,
} from "./incident-evidence.ts";

type Observer = (root: string, view: "current" | "safe") => Promise<HnsChainObservationResultV1>;
type Query = <Row = Record<string, unknown>>(
  text: string,
  values?: readonly unknown[],
) => Promise<{ rows: Row[] }>;

/** Incident classification alone permits recovery; dispatch resolution additionally
 * requires this UPDATE's inclusion beneath the safe commitment. */
export function walletPublicationIsConfirmed(report: HnsIncidentEvidenceReportV1): boolean {
  const { inclusion, current, safe, retained_plan_encoded_sha256: digest } = report.evidence;
  if (
    !report.recordable ||
    report.finding.classification !== "matching_authority_available" ||
    inclusion === null ||
    inclusion.covenant_action !== "UPDATE" ||
    inclusion.covenant_resource_sha256 !== digest ||
    current?.kind !== "observed" ||
    safe?.kind !== "observed"
  )
    return false;
  const commitment = safe.observation.commitment;
  return (
    commitment !== null &&
    inclusion.block_height < commitment.commitment_height &&
    inclusion.confirmations > commitment.minimum_confirmations &&
    current.observation.network === safe.observation.network &&
    current.observation.genesis_block_hash === safe.observation.genesis_block_hash &&
    current.observation.resource_sha256 === safe.observation.resource_sha256
  );
}

export async function retainWalletPublicationConfirmation(
  query: Query,
  report: HnsIncidentEvidenceReportV1,
): Promise<void> {
  if (!walletPublicationIsConfirmed(report)) return;
  const { evidence, finding } = report;
  const result = await query<{ outcome: string; recovery_finding_id: string }>(
    `SELECT * FROM record_hns_root_import_recovery_finding_v1(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      report.root_import_session_id,
      report.generation,
      report.evidence_ref,
      finding.classification,
      finding.reason,
      finding.supported_action,
      evidence.inclusion?.txid,
      evidence.inclusion?.block_height,
      evidence.inclusion?.covenant_resource_sha256,
      evidence.retained_plan_encoded_sha256,
      evidence.current?.kind === "observed" ? evidence.current.observation.resource_sha256 : null,
      evidence.safe?.kind === "observed" ? evidence.safe.observation.resource_sha256 : null,
      evidence.zone?.zone_present,
      evidence.zone?.signing_keys_present,
    ],
  );
  const findingRow = result.rows[0];
  if (findingRow && ["recorded", "replayed"].includes(findingRow.outcome)) {
    await query("SELECT observe_hns_wallet_publication_v1($1)", [findingRow.recovery_finding_id]);
  }
}

/** Piggyback on normal safe observations. No additional scheduler, timeout release
 * or wallet call: an unavailable inclusion reader leaves the attempt unresolved. */
export function makeHnsWalletPublicationObserver(
  connectionString: string,
  env: Readonly<Record<string, string | undefined>>,
  observe: Observer,
): Observer {
  return async (root, view) => {
    const result = await observe(root, view);
    if (view !== "safe" || result.kind !== "observed") return result;
    const client = new Client({ connectionString });
    try {
      await client.connect();
      const query: Query = async <Row>(text: string, values?: readonly unknown[]) => ({
        rows: (await client.query(text, values === undefined ? [] : [...values])).rows as Row[],
      });
      const pending = await query<{ root_import_session_id: string }>(
        `SELECT root_import_session_id FROM hns_wallet_publication_attempts
         WHERE root_label=$1 AND state IN ('dispatch_authorized','sent')`,
        [root],
      );
      for (const attempt of pending.rows) {
        const report = await gatherHnsIncidentEvidenceV1(
          attempt.root_import_session_id,
          makeHnsIncidentPortsFromConfigurationV1(env, query, fetch),
        );
        if (report !== null) await retainWalletPublicationConfirmation(query, report);
      }
    } catch {
      // A receipt inspection failure cannot invalidate a qualified chain read,
      // resolve an attempt, or expose provider credentials in diagnostics.
      console.error(
        JSON.stringify({
          event: "hns_wallet_publication_confirmation_unavailable",
          root_label: root,
        }),
      );
    } finally {
      await client.end().catch(() => undefined);
    }
    return result;
  };
}
