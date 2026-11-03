import type { Client } from "pg";
import type { HnsRootImportReadinessResultV1 } from "../../application/src/namespace-ownership/hns-root-import-readiness.ts";
import { readHnsStagingOwnerTxtRecovery } from "./hns-staging-owner-txt-recovery.ts";
import { requireHnsStagingOwnerTxtReview } from "./hns-staging-owner-txt-review.ts";
import { requireHnsStagingRelocationReview } from "./hns-staging-relocation-review.ts";
import type { HnsRootZoneAdoptionState } from "./hns-zone-adoption.ts";
import {
  type HnsZoneAdoptionDeltaKind,
  HnsZoneAdoptionDeltaRefusal,
  requireHnsZoneAdoptionDeltaV1,
} from "./hns-zone-adoption-delta.ts";

export async function requireHnsZoneAdoptionReview(
  client: Client,
  input: {
    readonly state: HnsRootZoneAdoptionState;
    readonly result: HnsRootImportReadinessResultV1;
    readonly zone_bytes: Uint8Array;
    readonly expected_delta: HnsZoneAdoptionDeltaKind;
    readonly reviewed_relocation?: unknown;
    readonly reviewed_owner_txt?: unknown;
    readonly lock: boolean;
    readonly database_time: number;
  },
): Promise<HnsZoneAdoptionDeltaKind> {
  const { state, result } = input;
  const refuse = (message: string): never => {
    throw new HnsZoneAdoptionDeltaRefusal(message);
  };
  if (input.reviewed_relocation !== undefined && input.reviewed_owner_txt !== undefined)
    refuse("staging relocation and owner TXT reviews are mutually exclusive");
  const predecessor = {
    environment: state.environment,
    root_label: state.root_label,
    generation: state.current_generation,
    health_generation: state.current_health_generation,
    gateway_reference: state.gateway_deployment_reference,
    certificate_spki: state.gateway_certificate_spki_sha256,
    chain_reference: state.stable_chain_delegation_snapshot_reference,
  };
  const relocation =
    input.reviewed_relocation === undefined
      ? undefined
      : await requireHnsStagingRelocationReview({
          review: input.reviewed_relocation,
          predecessor,
          observed: result,
          observed_at: result.observed_at,
        });
  const ownerTxt = input.reviewed_owner_txt !== undefined;
  if ((input.expected_delta === "staging_gateway_relocated") !== (relocation !== undefined))
    refuse("staging gateway relocation requires its explicit reviewed delta");
  if ((input.expected_delta === "staging_owner_txt_refreshed") !== ownerTxt)
    refuse("staging owner TXT refresh requires its explicit reviewed delta");
  if (
    result.dnssec_keyset_reference !== state.dnssec_keyset_reference ||
    result.dnssec_keyset_version !== state.dnssec_keyset_version ||
    result.gateway_certificate_spki_sha256 !== state.gateway_certificate_spki_sha256 ||
    (relocation === undefined &&
      result.gateway_deployment_reference !== state.gateway_deployment_reference) ||
    (relocation === undefined &&
      !ownerTxt &&
      `hns-root-chain:${result.chain_resource_sha256}` !==
        state.stable_chain_delegation_snapshot_reference)
  )
    refuse("the observation's keyset, gateway or chain reference is not the current revision's");
  if (ownerTxt) {
    const recovery = await readHnsStagingOwnerTxtRecovery(client, {
      review: input.reviewed_owner_txt,
      root_import_session_id: result.root_import_session_id,
      lock: input.lock,
    });
    requireHnsStagingOwnerTxtReview({
      review: input.reviewed_owner_txt,
      recovery,
      predecessor,
      observed_chain_sha256: result.chain_resource_sha256,
      database_time: input.database_time,
    });
    if (!Buffer.from(state.retained_zone_bytes).equals(input.zone_bytes))
      refuse("staging owner TXT refresh requires unchanged zone bytes and serial");
    return "staging_owner_txt_refreshed";
  }
  const delta = requireHnsZoneAdoptionDeltaV1({
    root_label: result.root_label,
    retained_zone_bytes: state.retained_zone_bytes,
    observed_zone_bytes: input.zone_bytes,
    ...(relocation === undefined ? {} : { staging_relocation: relocation }),
  });
  if (delta !== input.expected_delta)
    refuse(`the zone difference is ${delta}, not the one intended`);
  return delta;
}
