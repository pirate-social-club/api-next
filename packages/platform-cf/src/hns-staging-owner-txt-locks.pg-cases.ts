import { expect } from "bun:test";
import type { Client } from "pg";
import { adoptHnsRootZone } from "./hns-zone-adoption.ts";

/** Reproduce the ownership writer's community -> route -> app -> DNS order.
 * Adoption must wait before taking DNS, allowing that writer to finish. */
export async function verifyHnsOwnerTxtLockOrder(
  owner: Client,
  operator: Client,
  input: Parameters<typeof adoptHnsRootZone>[1],
) {
  const pid = (await operator.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
    ?.pid;
  if (pid === undefined) throw new Error("owner TXT operator PID is unavailable");
  await owner.query("BEGIN");
  let pending: Promise<{ error?: unknown; value?: unknown }> | undefined;
  let outcome: { error?: unknown; value?: unknown } | undefined;
  try {
    await owner.query(
      "SELECT 1 FROM communities WHERE community_id='community-root-import' FOR UPDATE",
    );
    await owner.query(
      "SELECT 1 FROM community_canonical_route_bindings WHERE route_binding_id='route-binding-root-import' FOR UPDATE",
    );
    await owner.query(
      "SELECT 1 FROM hns_community_app_host_activation_current WHERE app_host_activation_id='app-root-import' FOR UPDATE",
    );
    pending = adoptHnsRootZone(operator, input).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let waiting = false;
    for (let count = 0; count < 100; count += 1) {
      waiting =
        (
          await owner.query<{ waiting: boolean }>(
            "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0]?.waiting === true;
      if (waiting) break;
      await Bun.sleep(20);
    }
    expect(waiting).toBe(true);
    // With the old DNS-first order this fails NOWAIT and exposes the cycle.
    await owner.query(
      "SELECT 1 FROM hns_dns_zone_activation_current WHERE dns_zone_activation_id='dns-root-import' FOR SHARE NOWAIT",
    );
  } finally {
    await owner.query("ROLLBACK");
    if (pending !== undefined) {
      outcome = await pending;
    }
  }
  if (outcome?.error !== undefined) throw outcome.error;
  expect(outcome?.value).toMatchObject({ committed: false });
}
