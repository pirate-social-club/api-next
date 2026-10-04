import { ControlPlaneDb } from "@pirate/application";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect, Schema } from "effect";

const connection = Schema.Struct({ connectionString: Schema.String });

/** Hyperdrive's connection username identifies its pool, not the origin SQL role. */
async function readIsolatedSqlRole(connectionString: string): Promise<string> {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* db.execute<{ role: string }>({
          label: "rewards-e2e.resource-identity",
          text: "SELECT current_user::text AS role",
          values: [],
          readonly: true,
        });
      }).pipe(
        Effect.provide(
          makeHyperdriveControlPlaneLayer(
            { connectionString },
            {
              connectTimeoutMs: 5_000,
              statementTimeoutMs: 2_000,
              logger: { info: () => {}, error: () => {} },
            },
          ),
        ),
      ),
    ),
  );
  if (result.rows.length !== 1 || typeof result.rows[0]?.role !== "string" || !result.rows[0].role)
    throw new Error("Isolated SQL identity unavailable");
  return result.rows[0].role;
}

/** Recheck the actual SQL role per request; never cache a mutable Hyperdrive origin. */
export async function isIsolatedRequest(
  request: Request,
  bindings: { readonly API_NEXT_ENV?: string; readonly CONTROL_PLANE?: unknown },
  expectedRoleDigest: string,
  readRole: (connectionString: string) => Promise<string> = readIsolatedSqlRole,
): Promise<boolean> {
  if (
    bindings.API_NEXT_ENV !== "development" ||
    new URL(request.url).hostname !== "api-megapot-e2e-staging.pirate.sc" ||
    !/^[a-f0-9]{64}$/.test(expectedRoleDigest)
  ) {
    return false;
  }
  let stage = "binding-decoding";
  try {
    // Native Hyperdrive properties live on its prototype, rather than own keys.
    const decoded = Schema.decodeUnknownSync(connection)({
      connectionString: (
        bindings.CONTROL_PLANE as { readonly connectionString?: unknown } | undefined
      )?.connectionString,
    });
    stage = "sql-identity";
    const user = await readRole(decoded.connectionString);
    if (typeof user !== "string" || user.length === 0 || user.length > 128) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(user));
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hex !== expectedRoleDigest) {
      console.error("rewards_e2e_resource_refused", {
        stage: "sql-role-mismatch",
        observedDigest: hex,
      });
      return false;
    }
    return true;
  } catch {
    console.error("rewards_e2e_resource_refused", { stage });
    return false;
  }
}
