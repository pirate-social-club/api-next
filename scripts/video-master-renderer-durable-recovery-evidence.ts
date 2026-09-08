import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "pg";

const postgresImage = "postgres:17";
const localPassword = "renderer-recovery-evidence";
const schemaPattern = /^[a-z][a-z0-9_]*$/u;
const identifierPattern = /^[a-z0-9-]+$/u;

type ChildResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type AttemptInput = {
  readonly operationId: string;
  readonly renderInputHash: string;
  readonly attemptId: string;
  readonly bytes: Uint8Array;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function validateIdentifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

class FileMasterObjectStore {
  constructor(readonly root: string) {}

  keyFor(input: AttemptInput): string {
    validateIdentifier(input.operationId, "operation id");
    validateIdentifier(input.attemptId, "attempt id");
    return join("attempts", input.operationId, input.attemptId, `${sha256(input.bytes)}.master`);
  }

  pathFor(key: string): string {
    if (!/^attempts\/[a-z0-9-]+\/[a-z0-9-]+\/[a-f0-9]{64}\.master$/u.test(key)) {
      throw new Error("invalid object key");
    }
    return join(this.root, key);
  }

  async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readFile(path);
      if (sha256(existing) !== sha256(bytes)) throw new Error("immutable object collision");
    }
  }

  async verify(key: string, expectedHash: string): Promise<"valid" | "missing" | "corrupt"> {
    try {
      const bytes = await readFile(this.pathFor(key));
      return sha256(bytes) === expectedHash ? "valid" : "corrupt";
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
      throw error;
    }
  }

  async deleteIdempotent(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}

async function connect(): Promise<Client> {
  const connectionString = requiredEnvironment("VIDEO_RENDERER_RECOVERY_DB_URL");
  const client = await connectWithRetry(connectionString);
  const schema = requiredEnvironment("VIDEO_RENDERER_RECOVERY_SCHEMA");
  if (!schemaPattern.test(schema)) throw new Error("invalid recovery schema");
  await client.query(`SET search_path TO ${schema}`);
  return client;
}

async function connectWithRetry(connectionString: string): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await Bun.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PostgreSQL connection failed");
}

async function initializeSchema(connectionString: string, schema: string): Promise<void> {
  if (!schemaPattern.test(schema)) throw new Error("invalid recovery schema");
  const client = await connectWithRetry(connectionString);
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`
      CREATE TABLE ${schema}.renderer_attempts (
        attempt_id text PRIMARY KEY,
        operation_id text NOT NULL,
        render_input_hash text NOT NULL,
        master_hash text NOT NULL,
        object_key text NOT NULL UNIQUE,
        state text NOT NULL CHECK (state IN ('written', 'accepted', 'loser', 'disposed')),
        disposition text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.renderer_winners (
        operation_id text PRIMARY KEY,
        render_input_hash text NOT NULL,
        attempt_id text NOT NULL UNIQUE REFERENCES ${schema}.renderer_attempts(attempt_id),
        master_hash text NOT NULL,
        object_key text NOT NULL UNIQUE,
        accepted_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.renderer_invocations (
        attempt_id text PRIMARY KEY,
        operation_id text NOT NULL,
        process_pid integer NOT NULL,
        invoked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.renderer_events (
        event_id bigserial PRIMARY KEY,
        process_pid integer NOT NULL,
        event_kind text NOT NULL,
        operation_id text NOT NULL,
        attempt_id text,
        recorded_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await client.end();
  }
}

async function waitForStablePostgres(connectionString: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const first = await connectWithRetry(connectionString);
      await first.query("SELECT 1");
      await first.end();
      await Bun.sleep(250);
      const second = await connectWithRetry(connectionString);
      await second.query("SELECT 1");
      await second.end();
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("PostgreSQL host port did not become stable");
}

async function writeAttempt(
  input: AttemptInput,
): Promise<{ readonly objectKey: string; readonly hash: string }> {
  const client = await connect();
  const store = new FileMasterObjectStore(
    requiredEnvironment("VIDEO_RENDERER_RECOVERY_OBJECT_ROOT"),
  );
  const objectKey = store.keyFor(input);
  const hash = sha256(input.bytes);
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO renderer_invocations (attempt_id, operation_id, process_pid) VALUES ($1, $2, $3)",
      [input.attemptId, input.operationId, process.pid],
    );
    await client.query(
      `INSERT INTO renderer_attempts
        (attempt_id, operation_id, render_input_hash, master_hash, object_key, state)
       VALUES ($1, $2, $3, $4, $5, 'written')`,
      [input.attemptId, input.operationId, input.renderInputHash, hash, objectKey],
    );
    await client.query(
      "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, 'render_written', $2, $3)",
      [process.pid, input.operationId, input.attemptId],
    );
    await client.query("COMMIT");
    await store.putImmutable(objectKey, input.bytes);
    return { objectKey, hash };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function acceptAttemptOnce(attemptId: string) {
  const client = await connect();
  const store = new FileMasterObjectStore(
    requiredEnvironment("VIDEO_RENDERER_RECOVERY_OBJECT_ROOT"),
  );
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const attemptResult = await client.query<{
      operation_id: string;
      render_input_hash: string;
      master_hash: string;
      object_key: string;
    }>(
      `SELECT operation_id, render_input_hash, master_hash, object_key
       FROM renderer_attempts WHERE attempt_id = $1 FOR UPDATE`,
      [attemptId],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) throw new Error("attempt not found");
    const objectState = await store.verify(attempt.object_key, attempt.master_hash);
    if (objectState !== "valid") throw new Error(`attempt object ${objectState}`);

    const inserted = await client.query(
      `INSERT INTO renderer_winners
        (operation_id, render_input_hash, attempt_id, master_hash, object_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (operation_id) DO NOTHING
       RETURNING attempt_id`,
      [
        attempt.operation_id,
        attempt.render_input_hash,
        attemptId,
        attempt.master_hash,
        attempt.object_key,
      ],
    );
    if (inserted.rowCount === 1) {
      await client.query("UPDATE renderer_attempts SET state = 'accepted' WHERE attempt_id = $1", [
        attemptId,
      ]);
      await client.query(
        "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, 'winner_committed', $2, $3)",
        [process.pid, attempt.operation_id, attemptId],
      );
      await client.query("COMMIT");
      return { kind: "winner_committed", attemptId } as const;
    }

    const winnerResult = await client.query<{
      render_input_hash: string;
      attempt_id: string;
      master_hash: string;
      object_key: string;
    }>(
      "SELECT render_input_hash, attempt_id, master_hash, object_key FROM renderer_winners WHERE operation_id = $1",
      [attempt.operation_id],
    );
    const winner = winnerResult.rows[0];
    if (!winner) throw new Error("winner conflict was not observable");
    const disposition =
      winner.render_input_hash !== attempt.render_input_hash
        ? "replacement_loser"
        : winner.master_hash === attempt.master_hash
          ? "duplicate_loser"
          : "divergent_loser";
    await client.query(
      "UPDATE renderer_attempts SET state = 'loser', disposition = $2 WHERE attempt_id = $1",
      [attemptId, disposition],
    );
    await client.query(
      "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, 'loser_committed', $2, $3)",
      [process.pid, attempt.operation_id, attemptId],
    );
    await client.query("COMMIT");
    return {
      kind: "loser_committed",
      attemptId,
      disposition,
      winnerAttemptId: winner.attempt_id,
    } as const;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function acceptAttempt(attemptId: string) {
  let lastError: unknown;
  for (let retry = 0; retry < 5; retry += 1) {
    try {
      return await acceptAttemptOnce(attemptId);
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "40001") throw error;
      await Bun.sleep(10 * (retry + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("acceptance retry exhausted");
}

async function observeOrRecover(operationId: string, renderInputHash: string) {
  const client = await connect();
  const store = new FileMasterObjectStore(
    requiredEnvironment("VIDEO_RENDERER_RECOVERY_OBJECT_ROOT"),
  );
  try {
    const winnerResult = await client.query<{
      render_input_hash: string;
      attempt_id: string;
      master_hash: string;
      object_key: string;
    }>(
      "SELECT render_input_hash, attempt_id, master_hash, object_key FROM renderer_winners WHERE operation_id = $1",
      [operationId],
    );
    const winner = winnerResult.rows[0];
    if (winner) {
      if (winner.render_input_hash !== renderInputHash) {
        return { kind: "canonical_replacement_rejected", attemptId: winner.attempt_id } as const;
      }
      const objectState = await store.verify(winner.object_key, winner.master_hash);
      if (objectState !== "valid") {
        await client.query(
          "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, $2, $3, $4)",
          [process.pid, `winner_bytes_${objectState}`, operationId, winner.attempt_id],
        );
        return { kind: `winner_bytes_${objectState}` as const, attemptId: winner.attempt_id };
      }
      await client.query(
        "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, 'winner_observed', $2, $3)",
        [process.pid, operationId, winner.attempt_id],
      );
      return { kind: "winner_observed", attemptId: winner.attempt_id } as const;
    }

    const recoverable = await client.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM renderer_attempts
       WHERE operation_id = $1 AND render_input_hash = $2 AND state = 'written'
       ORDER BY created_at, attempt_id LIMIT 1`,
      [operationId, renderInputHash],
    );
    const attempt = recoverable.rows[0];
    if (!attempt) return { kind: "render_required" } as const;
    await client.query(
      "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, 'written_attempt_recovered', $2, $3)",
      [process.pid, operationId, attempt.attempt_id],
    );
    return await acceptAttempt(attempt.attempt_id);
  } finally {
    await client.end();
  }
}

async function cleanupLosers(operationId: string, crashAfterDelete: boolean) {
  const client = await connect();
  const store = new FileMasterObjectStore(
    requiredEnvironment("VIDEO_RENDERER_RECOVERY_OBJECT_ROOT"),
  );
  try {
    const rows = await client.query<{ attempt_id: string; object_key: string }>(
      `SELECT a.attempt_id, a.object_key FROM renderer_attempts a
       LEFT JOIN renderer_winners w ON w.object_key = a.object_key
       WHERE a.operation_id = $1 AND a.state = 'loser' AND w.object_key IS NULL
       ORDER BY a.attempt_id`,
      [operationId],
    );
    let deleted = 0;
    for (const row of rows.rows) {
      await store.deleteIdempotent(row.object_key);
      deleted += 1;
      await client.query(
        "INSERT INTO renderer_events (process_pid, event_kind, operation_id, attempt_id) VALUES ($1, $2, $3, $4)",
        [
          process.pid,
          crashAfterDelete ? "cleanup_deleted_before_crash" : "cleanup_delete_replayed",
          operationId,
          row.attempt_id,
        ],
      );
      if (crashAfterDelete) return { kind: "cleanup_interrupted", deleted } as const;
      await client.query("UPDATE renderer_attempts SET state = 'disposed' WHERE attempt_id = $1", [
        row.attempt_id,
      ]);
    }
    return { kind: "cleanup_complete", deleted } as const;
  } finally {
    await client.end();
  }
}

async function runChild(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0];
  if (command === "write") {
    const [operationId, inputHash, attemptId, payload] = arguments_.slice(1);
    if (!operationId || !inputHash || !attemptId || payload === undefined)
      throw new Error("write arguments missing");
    console.log(
      JSON.stringify(
        await writeAttempt({
          operationId,
          renderInputHash: inputHash,
          attemptId,
          bytes: new TextEncoder().encode(payload),
        }),
      ),
    );
    return;
  }
  if (command === "write-crash") {
    const [operationId, inputHash, attemptId, payload] = arguments_.slice(1);
    if (!operationId || !inputHash || !attemptId || payload === undefined)
      throw new Error("write-crash arguments missing");
    await writeAttempt({
      operationId,
      renderInputHash: inputHash,
      attemptId,
      bytes: new TextEncoder().encode(payload),
    });
    process.exit(73);
  }
  if (command === "accept" || command === "accept-lost-response") {
    const attemptId = arguments_[1];
    if (!attemptId) throw new Error("accept attempt missing");
    const result = await acceptAttempt(attemptId);
    if (command === "accept-lost-response") process.exit(74);
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "observe") {
    const [operationId, inputHash] = arguments_.slice(1);
    if (!operationId || !inputHash) throw new Error("observe arguments missing");
    console.log(JSON.stringify(await observeOrRecover(operationId, inputHash)));
    return;
  }
  if (command === "cleanup" || command === "cleanup-crash") {
    const operationId = arguments_[1];
    if (!operationId) throw new Error("cleanup operation missing");
    const result = await cleanupLosers(operationId, command === "cleanup-crash");
    if (command === "cleanup-crash") process.exit(75);
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error("unknown child command");
}

async function runProcess(
  environment: Readonly<Record<string, string>>,
  arguments_: readonly string[],
): Promise<ChildResult> {
  const child = Bun.spawn([process.execPath, import.meta.path, "child", ...arguments_], {
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function parsed(result: ChildResult): Record<string, unknown> {
  if (result.exitCode !== 0)
    throw new Error(`child failed with ${result.exitCode}: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function docker(arguments_: readonly string[], allowFailure = false): Promise<ChildResult> {
  const child = Bun.spawn(["docker", ...arguments_], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (!allowFailure && exitCode !== 0)
    throw new Error(`docker failed with ${exitCode}: ${stderr.trim()}`);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local port reservation failed");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function queryRows(connectionString: string, schema: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const winners = await client.query(
      `SELECT * FROM ${schema}.renderer_winners ORDER BY operation_id`,
    );
    const attempts = await client.query(
      `SELECT * FROM ${schema}.renderer_attempts ORDER BY attempt_id`,
    );
    const invocations = await client.query(
      `SELECT operation_id, count(*)::int AS count,
        array_agg(process_pid ORDER BY process_pid) AS process_pids
       FROM ${schema}.renderer_invocations GROUP BY operation_id ORDER BY operation_id`,
    );
    const events = await client.query(
      `SELECT process_pid, event_kind, operation_id, attempt_id
       FROM ${schema}.renderer_events ORDER BY event_id`,
    );
    return {
      winners: winners.rows,
      attempts: attempts.rows,
      invocations: invocations.rows,
      events: events.rows,
    };
  } finally {
    await client.end();
  }
}

export async function runDurableRecoveryEvidence() {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const containerName = `video-renderer-recovery-${suffix}`;
  const objectRoot = join(tmpdir(), containerName, "objects");
  const schema = `renderer_recovery_${process.pid}_${Date.now()}`;
  const postgresPort = await reserveLocalPort();
  await mkdir(objectRoot, { recursive: true });
  try {
    const postgresImageInspection = await docker([
      "image",
      "inspect",
      postgresImage,
      "--format",
      "{{.Id}}",
    ]);
    await docker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--pull=never",
      "--network=host",
      "--env",
      `POSTGRES_PASSWORD=${localPassword}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m",
      postgresImage,
      "-c",
      `port=${postgresPort}`,
    ]);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await docker(
        ["exec", containerName, "pg_isready", "-U", "postgres", "-p", String(postgresPort)],
        true,
      );
      if (ready.exitCode === 0) break;
      if (attempt === 49) throw new Error("PostgreSQL did not become ready");
      await Bun.sleep(100);
    }
    const connectionString = `postgres://postgres:${localPassword}@127.0.0.1:${postgresPort}/postgres`;
    await waitForStablePostgres(connectionString);
    await initializeSchema(connectionString, schema);
    const environment = {
      VIDEO_RENDERER_RECOVERY_DB_URL: connectionString,
      VIDEO_RENDERER_RECOVERY_SCHEMA: schema,
      VIDEO_RENDERER_RECOVERY_OBJECT_ROOT: objectRoot,
    };

    const crashWrite = await runProcess(environment, [
      "write-crash",
      "operation-crash",
      "input-a",
      "attempt-crash",
      "master-crash",
    ]);
    if (crashWrite.exitCode !== 73)
      throw new Error("write-before-acceptance crash was not observed");
    const recovered = parsed(
      await runProcess(environment, ["observe", "operation-crash", "input-a"]),
    );

    parsed(
      await runProcess(environment, [
        "write",
        "operation-lost",
        "input-b",
        "attempt-lost",
        "master-lost",
      ]),
    );
    const lostResponse = await runProcess(environment, ["accept-lost-response", "attempt-lost"]);
    if (lostResponse.exitCode !== 74) throw new Error("lost-response crash was not observed");
    const replayed = parsed(
      await runProcess(environment, ["observe", "operation-lost", "input-b"]),
    );

    parsed(
      await runProcess(environment, [
        "write",
        "operation-race",
        "input-c",
        "attempt-race-a",
        "master-race-a",
      ]),
    );
    parsed(
      await runProcess(environment, [
        "write",
        "operation-race",
        "input-c",
        "attempt-race-b",
        "master-race-b",
      ]),
    );
    const [raceA, raceB] = await Promise.all([
      runProcess(environment, ["accept", "attempt-race-a"]),
      runProcess(environment, ["accept", "attempt-race-b"]),
    ]);
    const raceResults = [parsed(raceA), parsed(raceB)];
    const cleanupCrash = await runProcess(environment, ["cleanup-crash", "operation-race"]);
    if (cleanupCrash.exitCode !== 75) throw new Error("cleanup interruption was not observed");
    const cleanupReplay = parsed(await runProcess(environment, ["cleanup", "operation-race"]));

    parsed(
      await runProcess(environment, [
        "write",
        "operation-corrupt",
        "input-d",
        "attempt-corrupt",
        "master-corrupt",
      ]),
    );
    parsed(await runProcess(environment, ["accept", "attempt-corrupt"]));
    parsed(
      await runProcess(environment, [
        "write",
        "operation-missing",
        "input-e",
        "attempt-missing",
        "master-missing",
      ]),
    );
    parsed(await runProcess(environment, ["accept", "attempt-missing"]));
    const beforeDamage = await queryRows(connectionString, schema);
    const store = new FileMasterObjectStore(objectRoot);
    const corruptWinner = beforeDamage.winners.find(
      (row) => row.operation_id === "operation-corrupt",
    );
    const missingWinner = beforeDamage.winners.find(
      (row) => row.operation_id === "operation-missing",
    );
    if (!corruptWinner || !missingWinner) throw new Error("damage fixtures missing winners");
    await writeFile(store.pathFor(String(corruptWinner.object_key)), "corrupt replacement bytes");
    await store.deleteIdempotent(String(missingWinner.object_key));
    const corruptObserved = parsed(
      await runProcess(environment, ["observe", "operation-corrupt", "input-d"]),
    );
    const missingObserved = parsed(
      await runProcess(environment, ["observe", "operation-missing", "input-e"]),
    );

    const rows = await queryRows(connectionString, schema);
    const winnerObjectStates = await Promise.all(
      rows.winners.map(async (winner) => ({
        operationId: winner.operation_id,
        attemptId: winner.attempt_id,
        state: await store.verify(String(winner.object_key), String(winner.master_hash)),
      })),
    );
    return {
      postgresImage,
      postgresImageId: postgresImageInspection.stdout,
      schema,
      recovered,
      replayed,
      raceResults,
      cleanupReplay,
      corruptObserved,
      missingObserved,
      winners: rows.winners.map((row) => ({
        operationId: row.operation_id,
        renderInputHash: row.render_input_hash,
        attemptId: row.attempt_id,
        masterHash: row.master_hash,
        objectKey: row.object_key,
      })),
      attempts: rows.attempts.map((row) => ({
        attemptId: row.attempt_id,
        operationId: row.operation_id,
        state: row.state,
        disposition: row.disposition,
        masterHash: row.master_hash,
        objectKey: row.object_key,
      })),
      invocations: rows.invocations,
      processEvents: rows.events,
      winnerObjectStates,
    } as const;
  } finally {
    await docker(["rm", "--force", containerName], true);
    await rm(join(tmpdir(), containerName), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv[2] === "child") {
    await runChild(process.argv.slice(3));
  } else {
    console.log(JSON.stringify(await runDurableRecoveryEvidence(), undefined, 2));
  }
}
