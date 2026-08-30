import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const TOKEN_MIN_BYTES = 32;
const TOKEN_MAX_BYTES = 512;

const boundedToken = (value: string): Uint8Array | undefined => {
  if (value.length === 0 || value !== value.trim()) return undefined;
  const bytes = encoder.encode(value);
  return bytes.byteLength >= TOKEN_MIN_BYTES && bytes.byteLength <= TOKEN_MAX_BYTES
    ? bytes
    : undefined;
};

const bearerToken = (authorization: string | undefined): Uint8Array | undefined => {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) return undefined;
  return boundedToken(authorization.slice("Bearer ".length));
};

export const isHnsEdgeAlertTokenConfigured = (value: string): boolean =>
  boundedToken(value) !== undefined;

/** Hashes both bounded values before the constant-time equality operation. */
export const hnsEdgeAlertBearerMatches = async (
  authorization: string | undefined,
  expectedToken: string,
): Promise<boolean> => {
  const provided = bearerToken(authorization);
  const expected = boundedToken(expectedToken);
  if (provided === undefined || expected === undefined) return false;
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", provided),
    crypto.subtle.digest("SHA-256", expected),
  ]);
  return timingSafeEqual(new Uint8Array(providedDigest), new Uint8Array(expectedDigest));
};
