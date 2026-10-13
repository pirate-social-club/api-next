import { describe, expect, test } from "bun:test";
import { postgresCiWaitDiagnosticsEnabled, safePostgresWaitRows, startPostgresCiWaitDiagnostic } from "./postgres-ci-wait-diagnostic.ts";

const row = { pid: 21, state: "active", wait_event_type: "Lock", wait_event: "relation", blocking_pids: [22,0],
  transaction_age_ms: 1400, query_age_ms: 600, state_age_ms: 600, query_digest: "a".repeat(32) };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 1));
async function until(check: () => boolean) {
  for (let n=0;n<100 && !check();n++) await tick();
  if (!check()) throw new Error("Diagnostic fixture did not reach its owned schedule");
}
function fixture() {
  const events: object[] = [], statements: string[] = [];
  let connects = 0, closes = 0, destroys = 0, listener: (() => void) | undefined;
  const client = { connect: async () => { connects += 1; }, query: async (text: string) => { statements.push(text); return { rows: [row] }; },
    end: async () => { closes += 1; }, destroy: () => { destroys += 1; }, pid: () => 20,
    onError: (value: () => void) => { listener = value; } };
  const options = { enabled: true, connectionString: "postgres://not-exported:credential@invalid/fixture", label: "postgres://secret-label", maximumLifetimeMs: 1000,
    intervalMs: 2, closeTimeoutMs: 20, client, emit: (event: object) => { events.push(event); } };
  return { client, options, events, statements, counts: () => ({ connects, closes, destroys }), error: () => listener?.() };
}

describe("required-CI PostgreSQL wait diagnostics", () => {
  test("only required CI enables observation; local or optional runs stay inert", async () => {
    expect(postgresCiWaitDiagnosticsEnabled({ CI: "true", CONTROL_PLANE_POSTGRES_TEST_REQUIRED: "1" })).toBe(true);
    for (const env of [{}, { CI: "true" }, { CONTROL_PLANE_POSTGRES_TEST_REQUIRED: "1" }, { CI: "false", CONTROL_PLANE_POSTGRES_TEST_REQUIRED: "1" }])
      expect(postgresCiWaitDiagnosticsEnabled(env)).toBe(false);
    const f=fixture(), observer=startPostgresCiWaitDiagnostic({ ...f.options, enabled: false }); await observer.stop();
    expect(f.counts()).toEqual({ connects: 0, closes: 0, destroys: 0 }); expect(f.events).toEqual([]);
  });
  test("projects only approved metadata; arbitrary SQL, credentials and ownPID never reach output", () => {
    const sample = safePostgresWaitRows([{ ...row, query: "SELECT secret", usename: "private-user", password: "credential", details: { secret: "private" } }, { ...row, pid: 20 }],20);
    expect(sample).toEqual([row]);
    expect(JSON.stringify(sample)).not.toMatch(/secret|credential|private-user|password|details/u);
    expect(safePostgresWaitRows([{ ...row, blocking_pids: [20,22,0] }],20)[0]?.blocking_pids).toEqual([22,0]);
    expect(() => safePostgresWaitRows([{ ...row, query_digest: "raw private SQL" }],20)).toThrow("shape unavailable");
    expect(() => safePostgresWaitRows(Array.from({length:129},()=>row),20)).toThrow("finite row bound");
  });
  test("stop closes once, cancels repeated observation and hides connection/label secrets", async () => {
    const f=fixture(), observer=startPostgresCiWaitDiagnostic(f.options);
    try { await until(() => f.statements.length > 0); }
    finally { await observer.stop(); }
    await observer.stop(); const samples=f.statements.length; await tick(); await tick();
    expect(f.statements).toHaveLength(samples); expect(f.counts()).toEqual({ connects:1, closes:1, destroys:1 });
    expect(JSON.stringify(f.events)).not.toMatch(/credential|secret-label|postgres:\/\//u);
    expect(f.events.at(-1)).toMatchObject({ event: "stopped", complete:true });
    expect(f.statements.every(sql=>sql.includes("pg_catalog.pg_stat_activity") && sql.includes("pid<>pg_catalog.pg_backend_pid()"))).toBe(true);
  });
  test("child finish during pending connection forces owned cancellation before any sample", async () => {
    const f=fixture(); let rejectConnect: ((error: Error) => void) | undefined;
    f.client.connect=()=>new Promise<void>((_resolve,reject)=>{rejectConnect=reject;});
    f.client.destroy=()=>{rejectConnect?.(new Error("private connection failure with credential"));};
    const observer=startPostgresCiWaitDiagnostic(f.options); await until(()=>rejectConnect!==undefined);
    await observer.stop(); expect(f.statements).toHaveLength(0);
    expect(JSON.stringify(f.events)).not.toContain("credential"); expect(f.events.at(-1)).toMatchObject({ event:"stopped",complete:true });
  });
  test("error/termination cancels the in-flight query, closes owned peer and handles late failures", async () => {
    const f=fixture(); let rejectQuery: ((error: Error) => void) | undefined;
    f.client.query=()=>new Promise<{rows: typeof row[]}>((_resolve,reject)=>{rejectQuery=reject;});
    f.client.destroy=()=>{rejectQuery?.(new Error("private SQL and credential"));};
    const observer=startPostgresCiWaitDiagnostic(f.options); await until(()=>rejectQuery!==undefined);
    f.error(); await observer.stop(); expect(f.counts().closes).toBe(1); expect(JSON.stringify(f.events)).not.toContain("credential");
    expect(f.events.at(-1)).toMatchObject({event:"stopped",complete:true});
  });
  test("lifetime cap closes while child remains active; failed sampling is unavailable evidence", async () => {
    const f=fixture(); f.client.query=async()=>{throw new Error("private server error containing URI/password");};
    const observer=startPostgresCiWaitDiagnostic({...f.options, maximumLifetimeMs:10});
    try { await until(()=>f.counts().closes===1); }
    finally { await observer.stop(); }
    expect(JSON.stringify(f.events)).not.toMatch(/URI|password|private server/u);
    expect(f.events.some(event=>"event" in event && event.event==="sample_failed")).toBe(true);
    expect(f.events.at(-1)).toMatchObject({event:"stopped",complete:true,samples:0});
  });
  test("unreleased observer reports incomplete custody within its finite deadline", async () => {
    const f=fixture(); f.client.end=()=>new Promise<void>(()=>{});
    const observer=startPostgresCiWaitDiagnostic({...f.options,closeTimeoutMs:2});
    await expect(observer.stop()).rejects.toThrow("did not release its owned connection");
    expect(f.events.at(-1)).toMatchObject({event:"stopped",complete:false});
  });
});
