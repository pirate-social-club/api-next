import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import { parseSpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const URL = "https://spaces-verifier.pirate.sc/v1/observe-root-authority";

const failure = (phase: string, details: Readonly<Record<string, string | number | null>>) => {
  // Never record the Access token, bearer token, signature, or verifier body.
  console.warn("spaces.root_authority.observation_failed", { phase, ...details });
};

export type SpacesRootAuthorityCredentials = Readonly<{
  accessClientId: string;
  accessClientSecret: string;
  bearerToken: string;
}>;

/** A 409 or temporary outage is retryable; neither can assert root drift. */
export function makeSpacesRootAuthorityObserver(
  credentials: SpacesRootAuthorityCredentials,
  fetchImpl: typeof fetch = fetch,
): SpacesRootAuthorityObserver {
  if (!credentials.accessClientId || !credentials.accessClientSecret || !credentials.bearerToken) {
    throw new TypeError("Spaces root verifier credentials are incomplete");
  }
  return {
    observe: async (input) => {
      const challenge = input.digestHex !== undefined && input.signatureHex !== undefined;
      if ((input.digestHex === undefined) !== (input.signatureHex === undefined)) {
        throw new TypeError("Incomplete Spaces root challenge");
      }
      let response: Response;
      try {
        response = await fetchImpl(URL, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "CF-Access-Client-Id": credentials.accessClientId,
            "CF-Access-Client-Secret": credentials.accessClientSecret,
            authorization: `Bearer ${credentials.bearerToken}`,
          },
          body: JSON.stringify({
            root: `@${input.canonicalRoot}`,
            ...(challenge
              ? { digest_hex: input.digestHex, signature_hex: input.signatureHex }
              : {}),
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        failure("transport", {
          error_name: error instanceof Error ? error.name : "unknown",
          error_message: error instanceof Error ? error.message.slice(0, 160) : "unknown",
        });
        throw error;
      }
      if (response.status === 409 || response.status === 503) {
        await response.body?.cancel();
        return { kind: "pending" };
      }
      if (response.status !== 200 || response.body === null) {
        failure("response", {
          status: response.status,
          cf_ray: response.headers.get("cf-ray"),
          content_type: response.headers.get("content-type"),
        });
        await response.body?.cancel();
        throw new Error("Spaces root verifier unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          total += result.value.byteLength;
          if (total > 65_536) throw new Error("Spaces root verifier response exceeds bound");
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return {
          kind: "verified",
          bytes,
          evidence: parseSpacesRootAuthorityEvidenceV1(bytes, input.canonicalRoot, challenge),
        };
      } catch (error) {
        failure("evidence", {
          error_name: error instanceof Error ? error.name : "unknown",
          error_message: error instanceof Error ? error.message.slice(0, 160) : "unknown",
        });
        throw error;
      }
    },
  };
}
