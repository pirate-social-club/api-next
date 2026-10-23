/** Maintained owner-only policy publication. Source only: the source author must
 * never execute --apply. Plan mode has no environment/connection side effects.
 * Actual apply requires the coordinator's separate reviewed resource admission.
 */
import { Effect } from "effect";
import { prepareModeratedDancePolicyPublication } from "../packages/application/src/use-cases/dance/moderated-policy.ts";
import { withRetainedControlPlaneCommandTransaction } from "../packages/platform-cf/src/control-plane-command-transaction.ts";
import { makeHyperdriveControlPlaneLayer } from "../packages/platform-cf/src/postgres.ts";

async function main() {
  const [mode, file, ...extra] = process.argv.slice(2);
  if ((mode !== "--plan" && mode !== "--apply") || file === undefined || extra.length !== 0)
    throw new Error(
      "Usage: provision-moderated-dance-policy.ts --plan|--apply <reviewed-input.json>",
    );
  const prepared = await Effect.runPromise(
    prepareModeratedDancePolicyPublication(JSON.parse(await Bun.file(file).text())),
  );
  if (mode === "--plan") {
    process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`);
    return;
  }
  const connectionString = process.env.CONTROL_PLANE_POSTGRES_URL;
  if (connectionString === undefined || connectionString.trim() === "")
    throw new Error("An independently admitted owner connection is required");
  const runtime = makeHyperdriveControlPlaneLayer({ connectionString });
  const result = await Effect.runPromise(
    withRetainedControlPlaneCommandTransaction((tx) =>
      tx.execute<{ policy_hash: string }>({
        label: "dance.policy.publish",
        text: "SELECT publish_moderated_dance_policy_v1($1::jsonb) AS policy_hash",
        values: [JSON.stringify(prepared)],
        readonly: false,
      }),
    ).pipe(Effect.provide(runtime)),
  );
  if (result.rows.length !== 1 || result.rows[0]?.policy_hash !== prepared.policy.hash)
    throw new Error("Policy publication acknowledgement unknown");
  process.stdout.write(
    `${JSON.stringify({ policy_id: prepared.policy_id, policy_hash: prepared.policy.hash, acceptance_ref: prepared.acceptance_ref })}\n`,
  );
}
if (import.meta.main)
  main().catch(() => {
    process.stderr.write(
      "Moderated policy publication failed or is unknown; do not retry before reconciliation.\n",
    );
    process.exitCode = 1;
  });
