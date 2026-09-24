import type {
  SpacesFinalIssuanceVerifier,
  SpacesVerificationResultV1,
  SpacesVerificationTargetV1,
} from "@pirate/application";
import { renderSpacesHandleV1 } from "@pirate/domain";
import { Effect } from "effect";

const VERIFY_URL = "https://spaces-verifier.pirate.sc/v1/verify-name";
const OBSERVE_URL = "https://spaces-verifier.pirate.sc/v1/observe-name";
const HEX_64 = /^[0-9a-f]{64}$/u;
const SCRIPT = /^5120[0-9a-f]{64}$/u;

export type SpacesVerifierFetch = (input: string, init: RequestInit) => Promise<Response>;

export type SpacesVerifierCredentials = Readonly<{
  accessClientId: string;
  accessClientSecret: string;
  bearerToken: string;
}>;

type VerifierEvidence = Readonly<{
  contract: string;
  network: string;
  name: string;
  root: string;
  recipient_script_pubkey_hex: string;
  tip_height: number;
  tip_age_seconds: number;
  commitment_height: number;
  commitment_root_hex: string;
  certificate_sha256_hex: string;
}>;

function parseEvidence(
  value: unknown,
  target: SpacesVerificationTargetV1,
  contract: string,
): VerifierEvidence {
  if (typeof value !== "object" || value === null) throw new Error("Invalid verifier evidence");
  const evidence = value as Record<string, unknown>;
  const name = renderSpacesHandleV1({
    namespace_root: target.namespace_root,
    handle_label: target.handle_label,
  });
  if (
    evidence.contract !== contract ||
    evidence.network !== "mainnet" ||
    evidence.name !== name ||
    evidence.root !== `@${target.namespace_root}` ||
    !SCRIPT.test(String(evidence.recipient_script_pubkey_hex)) ||
    !Number.isSafeInteger(evidence.tip_height) ||
    !Number.isSafeInteger(evidence.commitment_height) ||
    (evidence.tip_height as number) < 0 ||
    (evidence.commitment_height as number) < 0 ||
    !Number.isSafeInteger(evidence.tip_age_seconds) ||
    (evidence.tip_age_seconds as number) < 0 ||
    (evidence.tip_age_seconds as number) > 10_800 ||
    (evidence.tip_height as number) - (evidence.commitment_height as number) <= 144 ||
    !HEX_64.test(String(evidence.commitment_root_hex)) ||
    !HEX_64.test(String(evidence.certificate_sha256_hex))
  ) {
    throw new Error("Invalid verifier evidence");
  }
  return evidence as VerifierEvidence;
}

function finalEvidence(evidence: VerifierEvidence) {
  return {
    certificate_sha256_hex: evidence.certificate_sha256_hex,
    commitment_root_hex: evidence.commitment_root_hex,
    mined_height: evidence.commitment_height,
    verified_tip_height: evidence.tip_height,
    verifier_id: "pirate-spaces-verifier-mainnet",
    verifier_version: evidence.contract,
    observed_at: new Date().toISOString(),
  };
}

/** An exact-recipient check proves final issuance. On its 409 response, a
 * separate checked observation can identify a different final recipient. */
export function makeSpacesFinalIssuanceVerifier(
  credentials: SpacesVerifierCredentials,
  fetchImpl: SpacesVerifierFetch = fetch,
): SpacesFinalIssuanceVerifier {
  if (
    credentials.accessClientId.length === 0 ||
    credentials.accessClientSecret.length === 0 ||
    credentials.bearerToken.length === 0
  ) {
    throw new TypeError("Spaces verifier credentials are incomplete");
  }
  return {
    verify: (target) =>
      Effect.tryPromise({
        try: async (signal): Promise<SpacesVerificationResultV1> => {
          if (target.network !== "mainnet") throw new Error("Spaces verifier network mismatch");
          if (!SCRIPT.test(target.script_pubkey_hex)) throw new Error("Invalid recipient script");
          const name = renderSpacesHandleV1({
            namespace_root: target.namespace_root,
            handle_label: target.handle_label,
          });
          const response = await fetchImpl(VERIFY_URL, {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              "CF-Access-Client-Id": credentials.accessClientId,
              "CF-Access-Client-Secret": credentials.accessClientSecret,
              authorization: `Bearer ${credentials.bearerToken}`,
            },
            body: JSON.stringify({
              root: `@${target.namespace_root}`,
              name,
              recipient_script_pubkey_hex: target.script_pubkey_hex,
            }),
            signal,
          });
          if (response.status === 409) {
            await response.body?.cancel();
            const observed = await fetchImpl(OBSERVE_URL, {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                "CF-Access-Client-Id": credentials.accessClientId,
                "CF-Access-Client-Secret": credentials.accessClientSecret,
                authorization: `Bearer ${credentials.bearerToken}`,
              },
              body: JSON.stringify({ root: `@${target.namespace_root}`, name }),
              signal,
            });
            if (observed.status === 409) {
              await observed.body?.cancel();
              return { kind: "pending" };
            }
            if (observed.status !== 200) {
              await observed.body?.cancel();
              throw new Error("Spaces verifier unavailable");
            }
            const evidence = parseEvidence(
              await observed.json(),
              target,
              "spaces-verifier-name-observation-v1",
            );
            if (evidence.recipient_script_pubkey_hex === target.script_pubkey_hex) {
              return { kind: "final", evidence: finalEvidence(evidence) };
            }
            return {
              kind: "occupied_other",
              observed_script_pubkey_hex: evidence.recipient_script_pubkey_hex,
              evidence: finalEvidence(evidence),
            };
          }
          if (response.status !== 200) {
            await response.body?.cancel();
            throw new Error("Spaces verifier unavailable");
          }
          const evidence = parseEvidence(await response.json(), target, "spaces-verifier-v1");
          if (evidence.recipient_script_pubkey_hex !== target.script_pubkey_hex) {
            throw new Error("Spaces verifier recipient mismatch");
          }
          return {
            kind: "final",
            evidence: finalEvidence(evidence),
          };
        },
        catch: () => new Error("Spaces final verification unavailable"),
      }),
  };
}
