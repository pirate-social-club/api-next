import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const id = "8cb7658a0f7143359c1becfec6a15c23";

/** Fixed staging configuration, read only. In-process credential comparison;
 * no host, role, password or raw CLI output is returned to the caller.
 */
export async function assertRehearsalHyperdriveExclusion() {
  try {
    const runtime = new URL(process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL ?? "");
    const username = decodeURIComponent(runtime.username);
    if (
      !["postgres:", "postgresql:"].includes(runtime.protocol) ||
      !username.endsWith(".syu03e00w3ux") ||
      runtime.pathname !== "/postgres" ||
      runtime.searchParams.get("sslmode") !== "verify-full"
    )
      throw new Error();
    const { stdout } = await execute(
      "bunx",
      [
        "wrangler",
        "hyperdrive",
        "get",
        id,
        "--config",
        "apps/http-worker/wrangler.jsonc",
        "--env",
        "staging",
      ],
      { timeout: 30_000, maxBuffer: 1_048_576, encoding: "utf8" },
    );
    const observed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    if (
      observed.id !== id ||
      observed.origin?.host !== runtime.hostname ||
      String(observed.origin.port) !== (runtime.port || "5432") ||
      observed.origin.database !== "postgres" ||
      observed.origin.user !== username ||
      observed.caching?.disabled !== true
    )
      throw new Error();
    return {
      hyperdrive_id: id,
      source_branch_id: "syu03e00w3ux",
      origin_sha256: createHash("sha256").update(JSON.stringify(observed.origin)).digest("hex"),
      caching_disabled: true,
    };
  } catch {
    throw new Error("rehearsal_hyperdrive_exclusion_unproven");
  }
}
