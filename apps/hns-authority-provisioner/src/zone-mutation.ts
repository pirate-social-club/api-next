import { Client } from "pg";
import type { HnsZoneMutationLease } from "./provision-root.ts";

/** Session/job row locks cover the provider's inspect/mutate/read-back sequence. */
export async function withHnsRootZoneMutation<A>(
  connectionString: string,
  input: {
    readonly root_label: string;
    readonly challenge_txt_value: string;
    readonly mutation_lease?: HnsZoneMutationLease;
  },
  teardown: boolean,
  mutate: (signal: AbortSignal) => Promise<A>,
): Promise<A> {
  if (input.mutation_lease === undefined) throw new Error("HNS mutation lease is required");
  const client = new Client({ connectionString });
  const controller = new AbortController();
  const disconnected = () => controller.abort(new Error("HNS mutation database connection lost"));
  client.on("error", disconnected);
  client.on("end", disconnected);
  let begun = false;
  let stage: "connect" | "begin" | "lock" | "mutate" | "commit" = "connect";
  try {
    await client.connect();
    stage = "begin";
    await client.query("BEGIN");
    begun = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    stage = "lock";
    const retained = await client.query<{ admitted: boolean }>(
      "SELECT lock_hns_root_zone_mutation_v1($1,$2,$3,$4,$5,$6) AS admitted",
      [
        input.root_label,
        input.challenge_txt_value,
        teardown,
        input.mutation_lease.job_id,
        input.mutation_lease.executor_id,
        input.mutation_lease.lease_fence,
      ],
    );
    if (retained.rows.length !== 1 || retained.rows[0]?.admitted !== true)
      throw new Error("HNS zone mutation no longer admitted");
    stage = "mutate";
    const result = await mutate(controller.signal);
    controller.signal.throwIfAborted();
    stage = "commit";
    await client.query("COMMIT");
    return result;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    console.error(
      JSON.stringify({
        event: "hns_zone_mutation_stage_failed",
        stage,
        database_signal_aborted: controller.signal.aborted,
        ...(typeof code === "string" && /^[0-9A-Z_]{5,32}$/u.test(code) ? { code } : {}),
      }),
    );
    controller.abort(error);
    // No provider mutation is retried here, including an ambiguous COMMIT.
    if (begun) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
