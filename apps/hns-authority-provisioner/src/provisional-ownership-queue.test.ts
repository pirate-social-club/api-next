import { afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "pg";
import { makePostgresHnsOwnershipPreparation } from "./provisional-ownership-queue.ts";

const restored: Array<() => void> = [];
afterEach(() => {
  for (const restore of restored.splice(0)) restore();
});

for (const kind of ["community_provisional", "hns_name_signature"] as const) {
  test(`${kind} preparation closes its read before requiring safe publication`, async () => {
    const row = {
      root_import_session_id: "root-session",
      namespace_session_id: "namespace-session",
      root_label: "harbor",
      challenge_txt_value: "pirate-verification=fixture",
      publish_plan_sha256: "a".repeat(64),
      ownership_result_sha256: null,
      provision_authorization_kind: kind,
      plan_encoded_resource_sha256: "b".repeat(64),
      lifecycle_revision: 3,
      generation: 1,
    };
    const connect = spyOn(Client.prototype, "connect").mockImplementation(async () => {});
    const query = spyOn(Client.prototype, "query").mockImplementation(async () => ({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [row],
    }));
    const end = spyOn(Client.prototype, "end").mockImplementation(async () => {});
    restored.push(
      () => connect.mockRestore(),
      () => query.mockRestore(),
      () => end.mockRestore(),
    );
    let observations = 0;
    const prepare = makePostgresHnsOwnershipPreparation("unused-fixture", async () => {
      observations += 1;
      expect(end).toHaveBeenCalledTimes(1);
      throw new Error("safe-chain evidence unavailable");
    });
    await expect(
      prepare(
        {
          lifecycle_job_id: "42",
          root_import_session_id: "root-session",
          job_kind: "observe_readiness",
          lease_fence: 1,
          generation: 1,
        },
        "executor",
      ),
    ).rejects.toThrow("safe-chain evidence unavailable");
    expect(observations).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(row.ownership_result_sha256).toBeNull();
  });
}
