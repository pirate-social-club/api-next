import { createPublicKey, randomBytes, verify } from "node:crypto";
import { Schema } from "effect";
import type { CloudflareAccessJwtFetch } from "../packages/platform-cf/src/cloudflare-access-jwt.ts";
import {
  type KaraokeReconciliationEvidencePort,
  ReconciliationManifest,
  reconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  ReconciliationDigest as Digest,
  decodeReconciliation,
  reconciliationMillis,
  ReconciliationTime as Time,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";
import { KARAOKE_RESET_OBJECT_IDS } from "../packages/platform-cf/src/karaoke-reset-installation.ts";
import {
  admitKaraokeResetOperator,
  type KaraokeResetOperatorBindings,
} from "../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import { openKaraokePrivateArtifacts } from "./karaoke-private-artifacts.ts";

export const KaraokeCollectorAttestation = Schema.Struct({
  version: Schema.Literal("staging-karaoke-collector-attestation-v1"),
  challenge: Digest,
  operatorSubjectDigest: Digest,
  collectorSourceDigest: Digest,
  observedAt: Time,
  manifest: ReconciliationManifest,
});
const Signed = Schema.Struct({
  payload: Schema.String.check(Schema.isMaxLength(4_194_304)),
  signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{128}$/u)),
});

export interface KaraokeCollectorChallenge {
  readonly version: "staging-karaoke-collector-challenge-v1";
  readonly challenge: string;
  readonly operatorSubjectDigest: string;
  readonly epoch: string;
  readonly bucket: string;
}

export interface KaraokeAdapterTrust {
  readonly directory: string;
  /** All trust values come from reviewed operator configuration outside directory. */
  readonly collectorPublicKeyPem: string;
  readonly collectorSourceDigest: string;
  readonly epoch: string;
  readonly bucket: string;
  readonly residualDispositionId: string;
  /** Last independently retained history, never supplied by the new manifest. */
  readonly expectedHistory: Readonly<Record<string, readonly string[]>>;
  readonly operator: KaraokeResetOperatorBindings;
}

/** Collector must read providers, not re-sign supplied JSON. It receives no token. */
export interface KaraokeLiveCollector {
  collect(challenge: KaraokeCollectorChallenge): Promise<void>;
}

export async function openAuthenticatedKaraokeEvidence(
  trust: KaraokeAdapterTrust,
  assertion: string,
  collector: KaraokeLiveCollector,
  now: () => string = () => new Date().toISOString(),
  authenticationFetch?: CloudflareAccessJwtFetch,
): Promise<KaraokeReconciliationEvidencePort> {
  await admitKaraokeResetOperator(trust.operator, assertion, authenticationFetch);
  const startedAt = reconciliationMillis(now());
  const subject = trust.operator.KARAOKE_RESET_ACCESS_SUBJECT;
  if (
    !subject ||
    Object.keys(trust.expectedHistory).sort().join() !== [...KARAOKE_RESET_OBJECT_IDS].sort().join()
  ) {
    throw new Error("karaoke_adapter_trust_invalid");
  }
  const key = createPublicKey(trust.collectorPublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("karaoke_adapter_key_invalid");
  const challenge: KaraokeCollectorChallenge = {
    version: "staging-karaoke-collector-challenge-v1",
    challenge: Buffer.from(randomBytes(32)).toString("hex"),
    operatorSubjectDigest: reconciliationDigest(subject),
    epoch: trust.epoch,
    bucket: trust.bucket,
  };
  // Anchor the directory before collection; the producer may atomically replace
  // individual files but cannot substitute another run directory.
  const store = openKaraokePrivateArtifacts(trust.directory);
  try {
    await collector.collect(challenge);
    const signed = decodeReconciliation(
      Signed,
      JSON.parse(store.read("manifest.signed.json", 8_388_608)),
    );
    if (
      !verify(null, Buffer.from(signed.payload, "utf8"), key, Buffer.from(signed.signature, "hex"))
    ) {
      throw new Error("karaoke_adapter_signature_denied");
    }
    const attestation = decodeReconciliation(
      KaraokeCollectorAttestation,
      JSON.parse(signed.payload),
    );
    const finishedAt = reconciliationMillis(now());
    const observed = reconciliationMillis(attestation.observedAt);
    const manifest = attestation.manifest;
    if (
      attestation.challenge !== challenge.challenge ||
      attestation.operatorSubjectDigest !== challenge.operatorSubjectDigest ||
      attestation.collectorSourceDigest !== trust.collectorSourceDigest ||
      observed < startedAt ||
      observed > finishedAt ||
      finishedAt - observed > 60_000 ||
      finishedAt - startedAt > 60_000 ||
      finishedAt < startedAt ||
      manifest.epoch !== trust.epoch ||
      manifest.bucket !== trust.bucket ||
      manifest.residualDispositionId !== trust.residualDispositionId
    )
      throw new Error("karaoke_adapter_attestation_denied");
    for (const id of KARAOKE_RESET_OBJECT_IDS) {
      const targets = manifest.targets.filter((target) => target.objectId === id);
      const prior = trust.expectedHistory[id];
      if (
        targets.length !== 1 ||
        prior === undefined ||
        prior.some((receipt, index) => targets[0]?.receiptIds[index] !== receipt)
      ) {
        throw new Error("karaoke_adapter_history_denied");
      }
    }
    const artifacts = new Map<string, string>();
    let total = 0;
    for (const id of new Set([
      manifest.residualDispositionId,
      ...manifest.entries.map((entry) => entry.id),
    ])) {
      const bytes = store.read(`${id}.json`, 262_144);
      total += Buffer.byteLength(bytes, "utf8");
      if (total > 67_108_864 || reconciliationDigest(bytes) !== id)
        throw new Error("karaoke_adapter_artifact_denied");
      artifacts.set(id, bytes);
    }
    // Snapshot bytes, not mutable disk paths; the verifier still checks all scopes.
    return {
      async readCurrentAuthenticatedManifest() {
        const age = reconciliationMillis(now()) - observed;
        if (age < 0 || age > 60_000) throw new Error("karaoke_adapter_snapshot_expired");
        return structuredClone(manifest);
      },
      async readArtifact(id) {
        const value = artifacts.get(id);
        if (value === undefined) throw new Error("karaoke_adapter_reference_denied");
        return value;
      },
    };
  } finally {
    store.close();
  }
}
