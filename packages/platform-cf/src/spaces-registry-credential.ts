import { createHash, timingSafeEqual } from "node:crypto";
import {
  ControlPlaneDb,
  type HandleSalesStorageFailed,
  type SpacesRegistryEnvironmentV1,
} from "@pirate/application";
import { isCanonicalSpacesRootV1 } from "@pirate/domain";
import { Effect } from "effect";
import {
  instant,
  integer,
  mapped,
  one,
  type Row,
  storage,
  text,
} from "./handle-sales-internals.ts";

/**
 * Spaces registry operator credentials (spec 012 §5.3.13.5, ruling Q12). A
 * token is `pirate-spaces-registry-v1.<credential_id>.<secret>`, where the
 * secret carries 256 bits of randomness. The database stores only the SHA-256
 * verifier of the whole token, looked up by the credential id the token names
 * and compared in constant time. Credentials are minted only by the operator
 * script; no HTTP surface mints, rotates, or reveals one.
 */

const TOKEN_PREFIX = "pirate-spaces-registry-v1";
const TOKEN_PATTERN = /^pirate-spaces-registry-v1\.(srcred_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/u;
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ROTATION_OVERLAP_SECONDS = 7 * 24 * 60 * 60;

const randomHex = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

/** Returns the credential id a well-formed token names, or null. */
export function spacesRegistryTokenCredentialIdV1(token: string): string | null {
  return TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

export function spacesRegistryTokenVerifierV1(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two SHA-256 verifiers. A malformed stored value
 * still costs one comparison against the presented digest, never a shortcut.
 */
export function spacesRegistryVerifierMatchesV1(presented: string, stored: string): boolean {
  const presentedBytes = Buffer.from(VERIFIER_PATTERN.test(presented) ? presented : "", "hex");
  const storedValid = VERIFIER_PATTERN.test(stored);
  const storedBytes = Buffer.from(storedValid ? stored : "0".repeat(64), "hex");
  if (presentedBytes.byteLength !== 32) return false;
  return timingSafeEqual(presentedBytes, storedBytes) && storedValid;
}

export type SpacesRegistryCredentialMintInputV1 = Readonly<{
  operatorInstanceId: string;
  environment: SpacesRegistryEnvironmentV1;
  allowedRoots: readonly string[];
  authorizationReference: string;
  /**
   * With a positive overlap the current active credential keeps working for
   * that many seconds as `retiring`; zero revokes it at once. Any earlier
   * retiring credential is revoked.
   */
  rotationOverlapSeconds: number;
}>;

export type SpacesRegistryCredentialMintResultV1 = Readonly<{
  credential_id: string;
  token: string;
  operator_instance_id: string;
  environment: SpacesRegistryEnvironmentV1;
  allowed_roots: readonly string[];
  retired_credential_id: string | null;
  revoked_credential_ids: readonly string[];
  created_at: string;
}>;

/** Rejects a mint request before any database access. */
function assertSpacesRegistryCredentialMintInputV1(
  input: SpacesRegistryCredentialMintInputV1,
): void {
  const roots = [...input.allowedRoots];
  if (
    roots.length === 0 ||
    roots.length > 64 ||
    new Set(roots).size !== roots.length ||
    !roots.every(isCanonicalSpacesRootV1)
  ) {
    throw new TypeError("Spaces registry allowed roots are invalid");
  }
  if (
    !Number.isSafeInteger(input.rotationOverlapSeconds) ||
    input.rotationOverlapSeconds < 0 ||
    input.rotationOverlapSeconds > MAX_ROTATION_OVERLAP_SECONDS
  ) {
    throw new TypeError("Spaces registry rotation overlap is out of bounds");
  }
  if (!["development", "staging", "production"].includes(input.environment)) {
    throw new TypeError("Spaces registry environment is invalid");
  }
}

/**
 * Mints one active credential for an operator instance and environment and
 * rotates the previous one in the same transaction. The token is returned
 * exactly once; only its verifier is written.
 */
export const mintSpacesRegistryCredentialV1 = Effect.fn("mintSpacesRegistryCredentialV1")(
  function* (
    input: SpacesRegistryCredentialMintInputV1,
  ): Effect.fn.Return<
    SpacesRegistryCredentialMintResultV1,
    HandleSalesStorageFailed,
    ControlPlaneDb
  > {
    yield* Effect.try({
      try: () => assertSpacesRegistryCredentialMintInputV1(input),
      catch: () => storage("constraint"),
    });
    const credentialId = `srcred_${randomHex(16)}`;
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const token = `${TOKEN_PREFIX}.${credentialId}.${secret}`;
    const db = yield* ControlPlaneDb;
    return yield* mapped(
      db.withTransaction((transaction) =>
        Effect.gen(function* () {
          const clock = yield* transaction.execute<Row>({
            label: "spaces-registry.credential.clock",
            text: "SELECT clock_timestamp() AS database_now",
            values: [],
            readonly: false,
          });
          const now = one(clock.rows, "database clock").database_now;
          const current = yield* transaction.execute<Row>({
            label: "spaces-registry.credential.current.lock",
            text: `SELECT credential_id,status FROM spaces_registry_credentials
                    WHERE operator_instance_id=$1 AND environment=$2
                      AND status IN ('active','retiring')
                    ORDER BY CASE status WHEN 'retiring' THEN 0 ELSE 1 END,credential_id
                    FOR UPDATE`,
            values: [input.operatorInstanceId, input.environment],
            readonly: false,
          });
          const revoked: string[] = [];
          let retired: string | null = null;
          for (const row of current.rows) {
            const id = text(row, "credential_id");
            const retire = row.status === "active" && input.rotationOverlapSeconds > 0;
            yield* transaction.execute({
              label: retire
                ? "spaces-registry.credential.previous.retire"
                : "spaces-registry.credential.previous.revoke",
              text: retire
                ? `UPDATE spaces_registry_credentials
                      SET status='retiring',retiring_at=$2::timestamptz,
                          accept_until=$2::timestamptz + make_interval(secs=>$3)
                    WHERE credential_id=$1 AND status='active'`
                : `UPDATE spaces_registry_credentials
                      SET status='revoked',revoked_at=$2::timestamptz
                    WHERE credential_id=$1 AND status IN ('active','retiring')`,
              values: retire ? [id, now, input.rotationOverlapSeconds] : [id, now],
              readonly: false,
            });
            if (retire) retired = id;
            else revoked.push(id);
          }
          const inserted = yield* transaction.execute<Row>({
            label: "spaces-registry.credential.insert",
            text: `INSERT INTO spaces_registry_credentials (
                     credential_id,operator_instance_id,environment,allowed_roots,
                     verifier_sha256_hex,status,authorization_reference,created_at
                   ) VALUES ($1,$2,$3,$4::text[],$5,'active',$6,$7::timestamptz)
                   RETURNING created_at,cardinality(allowed_roots) AS root_count`,
            values: [
              credentialId,
              input.operatorInstanceId,
              input.environment,
              [...input.allowedRoots],
              spacesRegistryTokenVerifierV1(token),
              input.authorizationReference,
              now,
            ],
            readonly: false,
          });
          const row = one(inserted.rows, "minted Spaces registry credential");
          if (integer(row, "root_count") !== input.allowedRoots.length) {
            return yield* Effect.fail(storage("invalid-row"));
          }
          return {
            credential_id: credentialId,
            token,
            operator_instance_id: input.operatorInstanceId,
            environment: input.environment,
            allowed_roots: [...input.allowedRoots],
            retired_credential_id: retired,
            revoked_credential_ids: revoked,
            created_at: instant(row.created_at),
          } satisfies SpacesRegistryCredentialMintResultV1;
        }),
      ),
    );
  },
);
