import { createHash } from "node:crypto";

export interface ApiClientProvenance {
  readonly schemaVersion: 1;
  readonly package: "@pirate/api-client";
  /** Supplied by the generation boundary from packages/api-client/package.json. */
  readonly version: string;
  /** A content-addressed source identifier that remains stable after commit. */
  readonly sourceIdentifier: string;
  readonly openapiSha256: string;
  readonly clientSha256: string;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createApiClientProvenance(
  openapiText: string,
  clientText: string,
  version: string,
): ApiClientProvenance {
  const openapiSha256 = sha256(openapiText);
  return {
    schemaVersion: 1,
    package: "@pirate/api-client",
    version,
    sourceIdentifier: `api-next-contracts@${openapiSha256}`,
    openapiSha256,
    clientSha256: sha256(clientText),
  };
}

export function serializeApiClientProvenance(
  openapiText: string,
  clientText: string,
  version: string,
): string {
  return `${JSON.stringify(createApiClientProvenance(openapiText, clientText, version), null, 2)}\n`;
}
