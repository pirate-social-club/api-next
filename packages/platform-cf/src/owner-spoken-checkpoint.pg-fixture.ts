import type { PreparedSongFixtureOptions } from "./owner-study-starter.pg-fixture.ts";
// Actual maintained source fixture only: no supplements, fake producers or
// checkpoint locator insertion. Root supplies existing exact254/255/256 env.
import { expect } from "bun:test";
import { type MutationFixture, mutationFixture } from "./owner-study-mutations.pg-fixture.ts";
import { q } from "./owner-study-starter.pg-fixture.ts";
export type CheckpointFixture = MutationFixture;
const checkpointLeaves = [
  "persist_owner_guest_spoken_success_v1(jsonb,jsonb,text,text,jsonb,jsonb)",
  "read_owner_guest_spoken_success_v1(jsonb,jsonb,text,text)",
  "read_owner_guest_spoken_capture_v1(jsonb,jsonb,text,text)",
] as const;
export const checkpointFixture = (use: (f: CheckpointFixture) => Promise<void>, options?: PreparedSongFixtureOptions) =>
  mutationFixture(async (f) => {
    // The base's required pre-grant native ACL patch checks all29functions.
    // These three controlled checkpoint leaves remain ungranted until here;
    // runtime receives neither source helper nor native core/read/load writer.
    expect(
      (
        await f.admin.query(
          `SELECT p.proname,a.grantee,a.privilege_type
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=ANY($1::regprocedure[]) AND a.grantee<>p.proowner`,
          [checkpointLeaves],
        )
      ).rows,
    ).toEqual([]);
    for (const signature of checkpointLeaves)
      await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    await use(f);
  }, options);
