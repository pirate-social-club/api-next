import type { State } from "../src/ceremony.ts";
import type { Observation } from "../src/observation.ts";
import { challengeRecord, delegationRecord } from "../src/records.ts";
import { bindingDigest, type Binding } from "../src/protocol.ts";
export const hash = "0x" + "11".repeat(32),
  address = "0x" + "22".repeat(20);
export const binding: Binding = {
  network: "regtest",
  tld: "testname",
  chainId: 6343,
  registry: address,
  wrapper: address,
  controller: address,
  grantSigner: address,
  installationKey: address,
  communityId: hash,
  installationId: hash,
  revision: 1,
  hostingOrigin: "https://example.test",
  sourceSha256: hash,
  deploymentDigest: hash,
};
export function state(): State {
  return {
    id: hash,
    binding,
    bindingDigest: bindingDigest(binding),
    resourceDigest: hash,
    beforeResourceDigest: hash,
    publicationJson: "[]",
    nonce: hash,
    challenge: challengeRecord(hash),
    revision: 1,
    phase: "AwaitingConsent",
    condition: "consent_required",
    conditionDetail: null,
    lastObservation: null,
    createdAt: 0,
    consentDeadline: 259200,
    publicationDeadline: 172800,
    firstIncludedAt: null,
    maturityDeadline: null,
    maturedAt: null,
    ownershipEpoch: hash,
    consented: false,
    updatedAt: 0,
    nextObservationAt: 0,
    observationFailures: 0,
  };
}
const delegation = {
  chainId: 6343,
  registry: address,
  controller: address,
  communityId: hash,
};
export function observation(): Observation {
  return {
    network: "regtest",
    genesis: hash,
    tipHash: hash,
    tipHeight: 48,
    tipTime: 1000,
    fetchedAt: 1000,
    safeRoot: hash,
    safeResourceDigest: hash,
    safeOwnershipEpoch: hash,
    safeHeight: 48,
    resourceDigest: hash,
    ownershipEpoch: hash,
    inclusionHash: hash,
    inclusionHeight: 37,
    inclusionTime: 500,
    canonical: true,
    transferPending: false,
    expired: false,
    delegation: delegationRecord(delegation),
    challenge: challengeRecord(hash),
  };
}
