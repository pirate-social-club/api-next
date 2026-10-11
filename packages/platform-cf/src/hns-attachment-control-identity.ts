import {
  type ControlPlaneTransaction,
  RouteAttachmentCompletionStorageFailed,
} from "@pirate/application";
import {
  decodeHnsOwnerResponseBytes,
  decodeHnsOwnerTargetObservationV3Bytes,
  hnsControlIdentityDigest,
  hnsOwnerChallengeName,
  hnsOwnerChallengeValue,
  hnsOwnerChallengeValueSha256,
  type NamespaceOwnershipProviderCompleteResult,
} from "@pirate/application/namespace-ownership";
import { Effect, Predicate } from "effect";

/** Retain the verifier's already observed control facts for future renewal. */
export const persistAttachmentHnsControlIdentity = Effect.fn("persistAttachmentHnsControlIdentity")(
  function* (
    transaction: ControlPlaneTransaction,
    input: Readonly<{
      evidence_ref: string;
      root_label: string;
      upstream_session_ref: string;
      provider_result: NamespaceOwnershipProviderCompleteResult;
    }>,
  ) {
    const result = input.provider_result;
    if (result.status !== "verified" || !Predicate.isObject(result.observation)) return;
    const version = result.observation.observation_contract_version;
    // Older evidence without these facts remains ineligible for automatic renewal.
    if (
      version !== "pirate-hns-target-observation-v2" &&
      version !== "pirate-hns-target-observation-v3"
    )
      return;
    const identity = yield* Effect.tryPromise({
      try: async () => {
        const observation =
          version === "pirate-hns-target-observation-v3"
            ? (await decodeHnsOwnerTargetObservationV3Bytes(result.raw_response_bytes)).response
            : decodeHnsOwnerResponseBytes(result.raw_response_bytes).response;
        if (
          observation.status !== "verified" ||
          !("control_identity_digest" in observation) ||
          !("chain_authority_digest" in observation) ||
          !("expected_txt_value_sha256" in observation) ||
          typeof observation.control_identity_digest !== "string" ||
          typeof observation.chain_authority_digest !== "string" ||
          typeof observation.expected_txt_value_sha256 !== "string" ||
          observation.provider_evidence_ref !== result.provider_evidence_ref ||
          observation.observed_at !== result.observed_at ||
          observation.expires_at !== result.expires_at ||
          observation.upstream_session_ref !== input.upstream_session_ref ||
          observation.challenge_value !== hnsOwnerChallengeValue(input.upstream_session_ref) ||
          observation.expected_txt_value_sha256 !==
            (await hnsOwnerChallengeValueSha256(input.upstream_session_ref)) ||
          observation.challenge_name !==
            hnsOwnerChallengeName(observation.ownership_source, input.root_label) ||
          observation.control_identity_digest !==
            (await hnsControlIdentityDigest({
              ownership_source: observation.ownership_source,
              root_label: input.root_label,
              txt_name: observation.challenge_name,
              expected_txt_value: observation.challenge_value,
              chain_authority_digest: observation.chain_authority_digest,
            }))
        )
          throw new TypeError("Attachment control identity does not match its verified evidence");
        return observation;
      },
      catch: () => new RouteAttachmentCompletionStorageFailed(),
    });
    const inserted = yield* transaction.execute({
      label: "route-attachment.completion.insert-control-identity",
      text: `INSERT INTO community_route_hns_control_identities (
        evidence_ref, ownership_source, root_label, txt_name, expected_txt_value_sha256,
        control_identity_digest, chain_authority_digest, provider_evidence_ref
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: [
        input.evidence_ref,
        identity.ownership_source,
        input.root_label,
        identity.challenge_name,
        identity.expected_txt_value_sha256,
        identity.control_identity_digest,
        identity.chain_authority_digest,
        identity.provider_evidence_ref,
      ],
      readonly: false,
    });
    if (inserted.rowCount !== 1) return yield* new RouteAttachmentCompletionStorageFailed();
  },
);
