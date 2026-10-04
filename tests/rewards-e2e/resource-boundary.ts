import { Schema } from "effect";

const connection = Schema.Struct({ connectionString: Schema.String });

/** Hyperdrive has no runtime ID; pin its database role without emitting credentials. */
export async function isIsolatedRequest(
  request: Request,
  bindings: { readonly API_NEXT_ENV?: string; readonly CONTROL_PLANE?: unknown },
  expectedRoleDigest: string,
): Promise<boolean> {
  if (
    bindings.API_NEXT_ENV !== "development" ||
    new URL(request.url).hostname !== "api-megapot-e2e-staging.pirate.sc" ||
    !/^[a-f0-9]{64}$/.test(expectedRoleDigest)
  ) {
    return false;
  }
  try {
    const decoded = Schema.decodeUnknownSync(connection)(bindings.CONTROL_PLANE);
    const user = decodeURIComponent(new URL(decoded.connectionString).username);
    if (user.length === 0) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(user));
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return hex === expectedRoleDigest;
  } catch {
    return false;
  }
}
