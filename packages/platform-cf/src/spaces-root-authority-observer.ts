import type { SpacesRootAuthorityObserver } from "./spaces-owner-proof-repository.ts";
import { parseSpacesRootAuthorityEvidenceV1 } from "./spaces-root-authority-evidence.ts";

const URL = "https://spaces-verifier.pirate.sc/v1/observe-root-authority";

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
      const response = await fetchImpl(URL, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "CF-Access-Client-Id": credentials.accessClientId,
          "CF-Access-Client-Secret": credentials.accessClientSecret,
          authorization: `Bearer ${credentials.bearerToken}`,
        },
        body: JSON.stringify({
          root: `@${input.canonicalRoot}`,
          ...(challenge ? { digest_hex: input.digestHex, signature_hex: input.signatureHex } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 409 || response.status === 503) {
        await response.body?.cancel();
        return { kind: "pending" };
      }
      if (response.status !== 200 || response.body === null) {
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
      return {
        kind: "verified",
        bytes,
        evidence: parseSpacesRootAuthorityEvidenceV1(bytes, input.canonicalRoot, challenge),
      };
    },
  };
}
