import { expect } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneHnsRootHealthRenewalStatusStore } from "./hns-root-health-renewal-status.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

type Claim = { observation_job_id: string; request_sha256: string; lease_fence: string };

// Extends the real import/activation fixture; no second root bootstrap is needed.
export async function verifyHnsRenewalRecovery(
  admin: Client,
  connectionString: string,
  ready: () => Promise<{ result_bytes: Uint8Array; result_sha256: string }>,
): Promise<void> {
  const schedule = () =>
    admin.query("SELECT * FROM schedule_hns_root_health_renewals_v1(25,259200,7200)");
  const claim = async (executor = "authority-executor") =>
    (
      await admin.query<Claim>("SELECT * FROM claim_hns_root_health_renewal_job_v1($1,60)", [
        executor,
      ])
    ).rows;
  const finish = async (
    job: Claim,
    outcome = "retry",
    code = "authority_unavailable",
    executor = "authority-executor",
  ) =>
    (
      await admin.query<{ outcome: string }>(
        "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,$5,NULL,NULL,$6)",
        [
          job.observation_job_id,
          executor,
          Number(job.lease_fence),
          job.request_sha256,
          outcome,
          code,
        ],
      )
    ).rows[0]?.outcome;
  const due = () =>
    admin.query(
      "UPDATE hns_root_health_renewal_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE state='delayed'",
    );
  const status = () =>
    Effect.runPromise(
      makeControlPlaneHnsRootHealthRenewalStatusStore(
        makeDirectPostgresControlPlaneLayer(connectionString),
      ).load(),
    );

  await schedule();
  await verifyExistingFailedRows(admin);
  let identity: string | undefined;
  let previous: Claim | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const contender = new Client({ connectionString });
    await contender.connect();
    let claims: Claim[];
    try {
      const [first, second] = await Promise.all([
        claim(),
        contender.query<Claim>(
          "SELECT * FROM claim_hns_root_health_renewal_job_v1('authority-executor',60)",
        ),
      ]);
      claims = [...first, ...second.rows];
      expect(claims).toHaveLength(1);
    } finally {
      await contender.end();
    }
    const [job] = claims;
    if (job === undefined) throw new Error("Expected renewal claim");
    identity ??= job.observation_job_id;
    expect(job.observation_job_id).toBe(identity);
    expect(await claim("duplicate-worker")).toEqual([]);
    for (const [executor, fence] of [
      [null, Number(job.lease_fence)],
      ["authority-executor", null],
    ]) {
      expect(
        (
          await admin.query(
            "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'retry',NULL,NULL,'observation_failed')",
            [job.observation_job_id, executor, fence, job.request_sha256],
          )
        ).rows[0]?.outcome,
      ).toBe("lost");
    }
    expect(await finish(job, "retry", "authority_unavailable", "duplicate-worker")).toBe("lost");
    if (previous !== undefined) expect(await finish(previous)).toBe("lost");
    // The database also protects against a still-deployed executor classifying
    // an unknown first-attempt exception as failed.
    expect(
      await finish(
        job,
        attempt === 1 ? "failed" : "retry",
        attempt === 1 ? "observation_failed" : "authority_unavailable",
      ),
    ).toBe("retry");
    const stored = (
      await admin.query(
        "SELECT state,attempt_count,next_attempt_at>clock_timestamp() AS waiting,failure_code,extract(epoch FROM next_attempt_at-clock_timestamp())::integer AS delay FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0];
    expect(stored).toMatchObject({ state: "delayed", attempt_count: attempt, waiting: true });
    if (attempt === 3) expect(stored?.delay).toBeGreaterThan(1790);
    expect(await claim()).toEqual([]);
    expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 0 });
    expect(await status()).toMatchObject({ delayed_job_count: 1, terminal_job_count: 0 });
    previous = job;
    await due();
    expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 1 });
  }
  expect(
    (
      await admin.query(
        "SELECT count(*)::integer AS count FROM hns_root_health_renewal_jobs WHERE expected_health_generation=2",
      )
    ).rows[0]?.count,
  ).toBe(1);

  // The bounded counter saturates; it does not become another retry cutoff.
  await admin.query(
    "UPDATE hns_root_health_renewal_jobs SET attempt_count=1024 WHERE renewal_job_id=$1",
    [identity],
  );
  const [capped] = await claim();
  if (capped === undefined) throw new Error("Expected capped renewal claim");
  expect(await finish(capped)).toBe("retry");
  expect(
    (
      await admin.query(
        "SELECT state,attempt_count,extract(epoch FROM next_attempt_at-clock_timestamp())::integer AS delay FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0],
  ).toMatchObject({ state: "delayed", attempt_count: 1024 });
  await due();
  const [expired] = await claim();
  if (expired === undefined) throw new Error("Expected lease claim");
  await admin.query(
    "UPDATE hns_root_health_renewal_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_job_id=$1",
    [identity],
  );
  expect(await claim()).toEqual([]);
  expect(await finish(expired)).toBe("lost");
  expect(
    (
      await admin.query(
        "SELECT state,failure_code FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0],
  ).toMatchObject({ state: "delayed", failure_code: "lease_expired" });
  await due();
  const [recovered] = await claim();
  if (recovered === undefined) throw new Error("Expected recovered claim");
  expect(Number(recovered.lease_fence)).toBeGreaterThan(Number(expired.lease_fence));
  expect(await finish(expired)).toBe("lost");

  const blocker = new Client({ connectionString });
  await blocker.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT * FROM hns_dns_zone_activation_current WHERE dns_zone_activation_id='dns-root-import' FOR UPDATE",
    );
    await admin.query(
      "UPDATE hns_root_health_renewal_jobs SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE renewal_job_id=$1",
      [identity],
    );
    const waiting = finish(recovered);
    await blocker.query("SELECT pg_sleep(0.75)");
    await blocker.query("COMMIT");
    expect(await waiting).toBe("lost");
  } finally {
    await blocker.query("ROLLBACK");
    await blocker.end();
  }
  await admin.query(
    "UPDATE hns_root_health_renewal_jobs SET lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE renewal_job_id=$1",
    [identity],
  );

  // Independent transactions observe the real status query below; savepoints
  // isolate terminal and supersession cases within the imported fixture.
  await admin.query("BEGIN");
  await admin.query("SAVEPOINT terminal_case");
  expect(await finish(recovered, "failed", "authority_mismatch")).toBe("failed");
  expect(
    (
      await admin.query(
        "SELECT state,failure_code FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0],
  ).toMatchObject({ state: "terminal", failure_code: "authority_mismatch" });
  expect((await schedule()).rows[0]).toMatchObject({ enqueued_roots: 0 });
  expect(await claim()).toEqual([]);
  await admin.query("ROLLBACK TO SAVEPOINT terminal_case");
  const mismatched = await ready();
  const badResult = JSON.parse(new TextDecoder().decode(mismatched.result_bytes));
  delete badResult.delegation_matches;
  const badBytes = Buffer.from(JSON.stringify(badResult));
  expect(
    (
      await admin.query(
        "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,'authority-executor',$2,$3,'ready',$4,encode(sha256($4),'hex'),NULL)",
        [
          recovered.observation_job_id,
          Number(recovered.lease_fence),
          recovered.request_sha256,
          badBytes,
        ],
      )
    ).rows[0]?.outcome,
  ).toBe("failed");
  expect(
    (
      await admin.query(
        "SELECT state,failure_code FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0],
  ).toMatchObject({ state: "terminal", failure_code: "evidence_mismatch" });
  await admin.query("ROLLBACK TO SAVEPOINT terminal_case");

  await admin.query(`INSERT INTO hns_dns_zone_health_observations
    SELECT (jsonb_populate_record(NULL::hns_dns_zone_health_observations,
      to_jsonb(health)||jsonb_build_object('health_generation',3))).*
    FROM hns_dns_zone_health_observations AS health WHERE health_generation=2`);
  expect(await finish(recovered)).toBe("lost");
  expect(
    (
      await admin.query(
        "SELECT failure_code FROM hns_root_health_renewal_jobs WHERE renewal_job_id=$1",
        [identity],
      )
    ).rows[0]?.failure_code,
  ).toBe("generation_superseded");
  await admin.query("ROLLBACK TO SAVEPOINT terminal_case");

  await admin.query(`INSERT INTO hns_dns_zone_activation_revisions
    SELECT (jsonb_populate_record(NULL::hns_dns_zone_activation_revisions,
      to_jsonb(dns)||jsonb_build_object('dns_zone_activation_generation',2))).*
    FROM hns_dns_zone_activation_revisions AS dns WHERE dns_zone_activation_generation=1`);
  await admin.query(
    "UPDATE hns_dns_zone_activation_current SET current_generation=2,updated_at=clock_timestamp() WHERE dns_zone_activation_id='dns-root-import'",
  );
  expect(await finish(recovered)).toBe("lost");
  await admin.query("ROLLBACK");

  const result = await ready();
  expect(
    (
      await admin.query(
        "SELECT * FROM finalize_hns_root_health_renewal_job_v1($1,$2,$3,$4,'ready',$5,$6,NULL)",
        [
          recovered.observation_job_id,
          "authority-executor",
          Number(recovered.lease_fence),
          recovered.request_sha256,
          Buffer.from(result.result_bytes),
          result.result_sha256,
        ],
      )
    ).rows[0]?.outcome,
  ).toBe("ready");
  expect(
    (
      await admin.query(
        "SELECT max(health_generation) AS generation FROM hns_dns_zone_health_observations",
      )
    ).rows[0]?.generation,
  ).toBe("3");
  // A new readiness digest must not detach health from the retained DNS snapshot.
  expect(
    (
      await admin.query(
        "SELECT stable_chain_delegation_matches FROM resolve_hns_community_app_host_authority_v1('app.newroot',clock_timestamp())",
      )
    ).rows[0]?.stable_chain_delegation_matches,
  ).toBe(true);
  const healthy = await status();
  expect(healthy).toMatchObject({
    active_root_count: 1,
    healthy_root_count: 1,
    delayed_job_count: 0,
    terminal_job_count: 0,
  });
  expect(healthy.serving_remaining_seconds).toBeGreaterThan(0);
  expect(healthy.earliest_serving_valid_until_unix_seconds).not.toBeNull();
  expect(healthy.earliest_serving_valid_until_unix_seconds ?? 0).toBeLessThanOrEqual(
    healthy.earliest_health_valid_until_unix_seconds ?? 0,
  );

  await schedule();
  const [terminal] = await claim();
  if (terminal === undefined) throw new Error("Expected final terminal case");
  expect(await finish(terminal, "failed", "ownership_revoked")).toBe("failed");
  expect(await status()).toMatchObject({ delayed_job_count: 0, terminal_job_count: 1 });
  await schedule();
  expect(await claim()).toEqual([]);
}

async function verifyExistingFailedRows(admin: Client): Promise<void> {
  const previous = await Bun.file(
    new URL("../../../db/postgres/migrations/0119_hns_root_health_renewal.sql", import.meta.url),
  ).text();
  const recovery = await Bun.file(
    new URL(
      "../../../db/postgres/migrations/0120_hns_root_health_renewal_recovery.sql",
      import.meta.url,
    ),
  ).text();
  const previousTable = previous.slice(
    previous.indexOf("CREATE TABLE hns_root_health_renewal_jobs"),
    previous.indexOf("CREATE TABLE hns_root_health_renewal_scheduler_heartbeat"),
  );
  const retained = (
    await admin.query(
      "SELECT to_jsonb(job) AS job FROM hns_root_health_renewal_jobs AS job WHERE expected_health_generation=2",
    )
  ).rows[0]?.job;
  if (retained === undefined) throw new Error("Expected retained renewal job");
  await admin.query("BEGIN");
  try {
    for (const code of ["observation_failed", "renewal_attempts_exhausted", "authority_mismatch"]) {
      await admin.query("SAVEPOINT old_queue");
      // Restore the actual 0119 queue DDL inside the existing imported-root
      // fixture, then execute the real forward migration on populated rows.
      await admin.query("DROP TABLE hns_root_health_renewal_jobs");
      await admin.query(previousTable);
      await admin.query(
        `INSERT INTO hns_root_health_renewal_jobs
        SELECT (jsonb_populate_record(NULL::hns_root_health_renewal_jobs,
          $1::jsonb||jsonb_build_object('state','failed','attempt_count',3,
            'failure_code',$2::text,'completed_at',clock_timestamp(),
            'updated_at',clock_timestamp()))).*`,
        [JSON.stringify(retained), code],
      );
      await admin.query("DROP FUNCTION hns_root_health_renewal_terminal_failure_v1(text)");
      await admin.query("DROP FUNCTION hns_root_health_renewal_delay_v1(integer)");
      await admin.query(recovery);
      expect(
        (
          await admin.query(
            "SELECT renewal_job_id,state,failure_code,next_attempt_at IS NOT NULL AS delayed,attempt_count FROM hns_root_health_renewal_jobs WHERE expected_health_generation=2",
          )
        ).rows[0],
      ).toMatchObject({
        renewal_job_id: retained.renewal_job_id,
        state: code === "authority_mismatch" ? "terminal" : "delayed",
        failure_code: code,
        delayed: code !== "authority_mismatch",
        attempt_count: 3,
      });
      await admin.query("ROLLBACK TO SAVEPOINT old_queue");
    }
  } finally {
    await admin.query("ROLLBACK");
  }
}
