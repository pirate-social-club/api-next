import { expect, test } from "bun:test";
import type {
  HnsWalletPublicationCommandV1,
  HnsWalletPublicationResultV1,
} from "@pirate/contracts";
import { makeControlPlaneHnsWalletPublicationStore } from "../../../packages/platform-cf/src/hns-wallet-publication-repository.ts";
import { prepareAcknowledgedImport } from "./hns-community-activation.pg-fixture.ts";
import { makeHnsWalletPublicationHandlers } from "./hns-wallet-publication-handlers.ts";
import { createHttpWorker } from "./transport.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;
async function fixture() {
  const f = await prepareAcknowledgedImport({ connectionString: url!, acknowledge: false });
  let actor = f.actor;
  const app = createHttpWorker({
    handlers: makeHnsWalletPublicationHandlers(makeControlPlaneHnsWalletPublicationStore(f.layer)),
    authenticate: () => ({ kind: "user", subject: actor }),
    authorize: () => {},
  });
  const path = `${f.sessionUrl}/publication-attempts`;
  const call = (body?: HnsWalletPublicationCommandV1) =>
    app.request(path, {
      headers: { authorization: "test-account", "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  const reserve = (key = "reservation") =>
    call({
      command: "reserve",
      idempotency_key: key,
      expected_revision: f.revision,
      publish_plan_sha256: f.publishPlanSha256,
    });
  const authorize = (id: string) =>
    call({
      command: "authorize_dispatch",
      attempt_id: id,
      expected_revision: f.revision,
      publish_plan_sha256: f.publishPlanSha256,
    });
  const reserved = async () => {
    const response = await reserve();
    const body = (await response.json()) as HnsWalletPublicationResultV1;
    expect({ status: response.status, body }).toMatchObject({
      status: 200,
      body: { outcome: "reserved" },
    });
    return body.attempt.attempt_id;
  };
  return {
    ...f,
    call,
    reserve,
    authorize,
    reserved,
    setActor: (value: string) => {
      actor = value;
    },
  };
}

pgTest("reserves atomically across clients; a lost response resumes the same attempt", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.reserve("device-a"), f.reserve("device-b")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((r) => r.status === 200);
    const first = (await results[winner]!.json()) as HnsWalletPublicationResultV1;
    const replay = await f.reserve(winner === 0 ? "device-a" : "device-b");
    expect(await replay.json()).toMatchObject({
      outcome: "replayed",
      attempt: { attempt_id: first.attempt.attempt_id },
    });
    expect(await (await f.call()).json()).toMatchObject({ attempt: { state: "reserved" } });
  } finally {
    await f.cleanup();
  }
});

pgTest(
  "cancel and dispatch compete; a paused client cannot dispatch after cancellation",
  async () => {
    const f = await fixture();
    try {
      const id = await f.reserved();
      const [cancel, authorize] = await Promise.all([
        f.call({ command: "cancel", attempt_id: id }),
        f.authorize(id),
      ]);
      expect([cancel.status, authorize.status].sort()).toEqual([200, 409]);
      if (cancel.status === 200) {
        expect((await f.authorize(id)).status).toBe(409);
        expect((await f.reserve("retry-after-cancel")).status).toBe(200);
      } else {
        expect((await f.call({ command: "cancel", attempt_id: id })).status).toBe(409);
        expect((await f.reserve("retry-after-authorize")).status).toBe(409);
      }
    } finally {
      await f.cleanup();
    }
  },
);

pgTest("a lost winning authorization is not reissued by a retry or status read", async () => {
  const f = await fixture();
  try {
    const id = await f.reserved();
    const results = await Promise.all([f.authorize(id), f.authorize(id)]);
    const bodies = await Promise.all(
      results.map((r) => r.json() as Promise<HnsWalletPublicationResultV1>),
    );
    expect(bodies.map((b) => b.outcome).sort()).toEqual([
      "already_authorized",
      "dispatch_authorized",
    ]);
    expect(await (await f.authorize(id)).json()).toMatchObject({ outcome: "already_authorized" });
    const status = await (await f.call()).json();
    expect(status).not.toHaveProperty("outcome");
    expect((await f.reserve("new-device")).status).toBe(409);
  } finally {
    await f.cleanup();
  }
});

pgTest(
  "explicit owner risk acceptance preserves history and permits a new reservation",
  async () => {
    const f = await fixture();
    try {
      const id = await f.reserved();
      await f.authorize(id);
      expect(
        (
          await f.call({
            command: "accept_retry",
            attempt_id: id,
            accept_duplicate_or_late_publication: true,
          })
        ).status,
      ).toBe(200);
      expect((await f.reserve("accepted-retry")).status).toBe(200);
      expect(await (await f.authorize(id)).json()).toMatchObject({ outcome: "already_authorized" });
      expect(
        (
          await f.admin.query(
            "SELECT state FROM hns_wallet_publication_attempts WHERE attempt_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ state: "retry_accepted" }]);
    } finally {
      await f.cleanup();
    }
  },
);

for (const stale of ["owner", "session", "plan", "deadline"] as const) {
  pgTest(`authorization rechecks ${stale} after reservation`, async () => {
    const f = await fixture();
    try {
      const id = await f.reserved();
      if (stale === "owner")
        await f.admin.query(
          "UPDATE community_route_authority_grants SET status='revoked',revoked_at=clock_timestamp(),revoked_by_user_id=principal_user_id WHERE community_id=$1",
          [f.community],
        );
      if (stale === "session")
        await f.admin.query(
          "UPDATE hns_root_import_sessions SET status='expired',revision=revision+1 WHERE root_import_session_id=$1",
          [f.sessionId],
        );
      // Plans are immutable within an existing session; a changed client digest must still be refused.
      if (stale === "deadline")
        await f.admin.query(
          "UPDATE hns_root_import_lifecycle SET publication_deadline_at=clock_timestamp()-interval '1 second' WHERE root_import_session_id=$1",
          [f.sessionId],
        );
      const response =
        stale === "plan"
          ? await f.call({
              command: "authorize_dispatch",
              attempt_id: id,
              expected_revision: f.revision,
              publish_plan_sha256: "a".repeat(64),
            })
          : await f.authorize(id);
      expect(response.status).toBe(stale === "owner" ? 404 : 409);
      expect(
        (
          await f.admin.query(
            "SELECT state FROM hns_wallet_publication_attempts WHERE attempt_id=$1",
            [id],
          )
        ).rows,
      ).toEqual([{ state: "reserved" }]);
    } finally {
      await f.cleanup();
    }
  });
}

async function finding(f: Awaited<ReturnType<typeof fixture>>, txid: string) {
  const row = (
    await f.admin.query(
      `SELECT generation,plan_encoded_resource_sha256 AS digest
    FROM hns_root_import_lifecycle WHERE root_import_session_id=$1`,
      [f.sessionId],
    )
  ).rows[0];
  const result = await f.admin.query(
    `SELECT * FROM record_hns_root_import_recovery_finding_v1(
    $1,$2,$3,'matching_authority_available','published_resource_matches_plan','resume',
    $4,100,$5,$5,$5,$5,true,true)`,
    [f.sessionId, row.generation, `fixture:${txid}`, txid, row.digest],
  );
  return result.rows[0].recovery_finding_id;
}

for (const reportFirst of [false, true]) {
  pgTest(
    `confirms only the reported transaction with qualified inclusion, report first: ${reportFirst}`,
    async () => {
      const f = await fixture();
      try {
        const id = await f.reserved();
        await f.authorize(id);
        const txid = "b".repeat(64);
        const report = () => f.call({ command: "report_txid", attempt_id: id, txid });
        if (reportFirst) expect((await report()).status).toBe(200);
        const evidence = await finding(f, txid);
        expect(await (await f.call()).json()).toMatchObject({
          attempt: { state: reportFirst ? "sent" : "dispatch_authorized" },
        });
        // The provisioner's separately tested inclusion qualifier owns this write.
        await f.admin.query("SELECT observe_hns_wallet_publication_v1($1)", [evidence]);
        if (!reportFirst) expect((await report()).status).toBe(200);
        expect(await (await f.call()).json()).toMatchObject({
          attempt: { state: "confirmed", txid },
        });
        expect((await f.reserve("next-attempt")).status).toBe(200);
      } finally {
        await f.cleanup();
      }
    },
  );
}

pgTest("a manual matching publication cannot retire an unreported paused sender", async () => {
  const f = await fixture();
  try {
    const id = await f.reserved();
    await f.authorize(id);
    const evidence = await finding(f, "c".repeat(64));
    await f.admin.query("SELECT observe_hns_wallet_publication_v1($1)", [evidence]);
    expect(await (await f.call()).json()).toMatchObject({
      attempt: { state: "dispatch_authorized" },
    });
    expect((await f.reserve("manual-match")).status).toBe(409);
    expect(
      (await f.call({ command: "report_txid", attempt_id: id, txid: "b".repeat(64) })).status,
    ).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({ attempt: { state: "sent" } });
    expect(
      (await f.call({ command: "report_txid", attempt_id: id, txid: "c".repeat(64) })).status,
    ).toBe(409);
    f.setActor("another-device-owner");
    expect((await f.call()).status).toBe(404);
  } finally {
    await f.cleanup();
  }
});

pgTest("an unresolved root attempt also fences a different session and plan", async () => {
  const f = await fixture();
  try {
    const id = await f.reserved();
    await f.authorize(id);
    // Seed a later retained session to isolate the root fence from import admission.
    // Only the INSERT fixture guard is suspended; all reservation guards stay on.
    // This does not prove the separate retire/re-import product journey.
    const newId = `${f.sessionId}-successor`;
    await f.admin.query(
      "UPDATE hns_root_import_sessions SET status='expired',revision=revision+1 WHERE root_import_session_id=$1",
      [f.sessionId],
    );
    await f.admin.query(
      "ALTER TABLE hns_root_import_sessions DISABLE TRIGGER hns_root_import_sessions_insert_guard",
    );
    await f.admin.query(
      `INSERT INTO hns_root_import_sessions SELECT (jsonb_populate_record(
      NULL::hns_root_import_sessions,to_jsonb(s) || jsonb_build_object(
        'root_import_session_id',$2::text,'namespace_session_id',$2::text,'provision_job_id',$2::text,
        'start_idempotency_key',$2::text,'status','awaiting_owner_update','revision',$3::bigint))).* FROM hns_root_import_sessions s WHERE root_import_session_id=$1`,
      [f.sessionId, newId, f.revision],
    );
    await f.admin.query(
      "ALTER TABLE hns_root_import_sessions ENABLE TRIGGER hns_root_import_sessions_insert_guard",
    );
    await f.admin.query(
      `INSERT INTO hns_root_import_lifecycle SELECT (jsonb_populate_record(
      NULL::hns_root_import_lifecycle,to_jsonb(l) || jsonb_build_object('root_import_session_id',$2::text))).*
      FROM hns_root_import_lifecycle l WHERE root_import_session_id=$1`,
      [f.sessionId, newId],
    );
    await f.admin.query(
      `INSERT INTO hns_root_import_publication_authorizations
      SELECT (jsonb_populate_record(NULL::hns_root_import_publication_authorizations,
        to_jsonb(a) || jsonb_build_object('root_import_session_id',$2::text,'namespace_session_id',$2::text))).*
      FROM hns_root_import_publication_authorizations a WHERE root_import_session_id=$1`,
      [f.sessionId, newId],
    );
    const result = await f.admin.query(
      "SELECT * FROM command_hns_wallet_publication_v1($1,$2,$3,$4,$5::jsonb)",
      [
        f.actor,
        f.community,
        newId,
        "new-attempt",
        JSON.stringify({
          command: "reserve",
          idempotency_key: "new-plan",
          expected_revision: f.revision,
          publish_plan_sha256: f.publishPlanSha256,
        }),
      ],
    );
    expect(result.rows[0].outcome).toBe("publication_unresolved");
    expect((await f.authorize(id)).status).toBe(409);
  } finally {
    await f.cleanup();
  }
});

pgTest("the restricted runtime can command but cannot forge or remove receipts", async () => {
  const f = await fixture();
  const role = `wallet_runtime_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    // The generated test baseline deliberately omits ACLs. Reapply this exact
    // migration in the private fixture schema to test its real privilege boundary.
    await f.admin.query(`DROP FUNCTION read_hns_wallet_publication_v1(text,text,text);
      DROP FUNCTION command_hns_wallet_publication_v1(text,text,text,text,jsonb);
      DROP FUNCTION observe_hns_wallet_publication_v1(bigint);
      DROP FUNCTION confirm_hns_wallet_publication_v1(bigint);
      DROP TABLE hns_wallet_publication_attempts CASCADE`);
    await f.admin.query(
      await Bun.file(
        new URL(
          "../../../db/postgres/migrations/0236_hns_wallet_publication_attempts.sql",
          import.meta.url,
        ),
      ).text(),
    );
    const schema = (await f.admin.query("SELECT current_schema() AS name")).rows[0].name;
    await f.admin.query(`CREATE ROLE "${role}"`);
    await f.admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await f.admin.query(
      `GRANT EXECUTE ON FUNCTION command_hns_wallet_publication_v1(text,text,text,text,jsonb),read_hns_wallet_publication_v1(text,text,text) TO "${role}"`,
    );
    await f.admin.query(`SET ROLE "${role}"`);
    for (const sql of [
      "SELECT * FROM hns_wallet_publication_attempts",
      "DELETE FROM hns_wallet_publication_attempts",
      "SELECT observe_hns_wallet_publication_v1(1)",
    ]) {
      await expect(f.admin.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
    // A hostile temporary relation must not shadow the definer's ledger.
    await f.admin.query("CREATE TEMP TABLE hns_wallet_publication_attempts (forged text)");
    const result = await f.admin.query(
      "SELECT * FROM command_hns_wallet_publication_v1($1,$2,$3,$4,$5::jsonb)",
      [
        f.actor,
        f.community,
        f.sessionId,
        "restricted-attempt",
        JSON.stringify({
          command: "reserve",
          idempotency_key: "restricted",
          expected_revision: f.revision,
          publish_plan_sha256: f.publishPlanSha256,
        }),
      ],
    );
    expect(result.rows[0].outcome).toBe("reserved");
    await expect(
      f.admin.query("SELECT * FROM command_hns_wallet_publication_v1($1,$2,$3,$4,$5::jsonb)", [
        "not-owner",
        f.community,
        f.sessionId,
        "forged-attempt",
        JSON.stringify({ command: "cancel", attempt_id: "restricted-attempt" }),
      ]),
    ).resolves.toMatchObject({ rows: [{ outcome: "not_found", attempt: null }] });
  } finally {
    await f.admin.query("RESET ROLE");
    await f.admin.query(`DROP OWNED BY "${role}"`);
    await f.admin.query(`DROP ROLE "${role}"`);
    await f.cleanup();
  }
});
