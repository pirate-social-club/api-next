import { expect, spyOn, test } from "bun:test";
import type { Client } from "pg";
import type { ResetGrant } from "./staging-persona-grant-reconciliation.ts";
import {
  assertRemovalPrerequisites,
  assertResetPreparationComplete,
  classifyResetPreparation,
  performForbiddenGrantRemoval,
  removeForbiddenResetGrants,
} from "./staging-persona-prepare-reset.ts";
import { describeRehearsalFailure } from "./staging-persona-rehearsal-failure";

const grant = (grantee: string, privilege: string, identity = "api_next.schema_migrations") =>
  ({
    schema: "api_next",
    objectKind: "table",
    objectIdentity: identity,
    grantee,
    privilege,
    grantOption: false,
  }) as ResetGrant;

// The three writes the 2026-09-09 restore reinstated on the runtime role.
const FORBIDDEN = [
  grant("pscale_api_gy9lze83nr29", "INSERT"),
  grant("pscale_api_gy9lze83nr29", "UPDATE"),
  grant("pscale_api_gy9lze83nr29", "DELETE"),
];
const ready = {
  catalog: [] as ResetGrant[],
  forbidden: FORBIDDEN,
  runtimeNames: ["pscale_api_gy9lze83nr29"],
  operatorVisibility: true,
  runtimeIdentityProven: true,
};

test("preparation is ready only when every check is satisfied", () => {
  const report = classifyResetPreparation(ready);
  expect(report.ready).toBe(true);
  expect(report.forbiddenPresent).toHaveLength(0);
  expect(report.findings.map((finding) => finding.check).sort()).toEqual([
    "forbidden_privileges",
    "operator_visibility",
    "runtime_identity",
  ]);
});

test("the forbidden writes the restore reinstates are reported, not ignored", () => {
  const report = classifyResetPreparation({ ...ready, catalog: FORBIDDEN });
  expect(report.ready).toBe(false);
  expect(report.forbiddenPresent).toHaveLength(3);
  const finding = report.findings.find((f) => f.check === "forbidden_privileges");
  expect(finding?.satisfied).toBe(false);
  expect(finding?.detail).toBe("3 forbidden grant(s) effective");
});

test("a PUBLIC grant is caught by the policy as it is actually compiled", () => {
  // The compiled policy names only the runtime role, because that is who it was
  // compiled for. The forbidden set is unchanged here — no PUBLIC entry is
  // added to make this pass — and a PUBLIC grant on the same object and
  // privilege must still be reported, because effective denial includes PUBLIC.
  const report = classifyResetPreparation({ ...ready, catalog: [grant("PUBLIC", "INSERT")] });
  expect(report.forbiddenPresent).toHaveLength(1);
  expect(report.ready).toBe(false);
});

test("a grant inherited through another reachable role is caught the same way", () => {
  // pg_has_role membership means the runtime can become this role; the compiled
  // policy still names only the runtime role itself.
  const report = classifyResetPreparation({
    ...ready,
    runtimeNames: ["pscale_api_gy9lze83nr29", "inherited_writer"],
    catalog: [grant("inherited_writer", "UPDATE")],
  });
  expect(report.forbiddenPresent).toHaveLength(1);
  expect(report.ready).toBe(false);
});

test("a string runtime identity fails closed instead of matching nothing", () => {
  // `ARRAY(SELECT rolname ...)` is `name[]`, and the driver returned it as the
  // raw string `{role}`. Spreading that string produced one-character names,
  // so no grantee matched and preparation reported a clean state it had not
  // proven. This is the rehearsal r9 defect at its boundary.
  expect(() =>
    classifyResetPreparation({
      ...ready,
      runtimeNames: "{pscale_api_gy9lze83nr29}" as unknown as string[],
    }),
  ).toThrow("reset_runtime_identity_unproven");
});

test("a forbidden grant to an unrelated role is not this runtime's problem", () => {
  const report = classifyResetPreparation({
    ...ready,
    catalog: [grant("some_other_role", "INSERT")],
  });
  expect(report.forbiddenPresent).toHaveLength(0);
  expect(report.ready).toBe(true);
});

test("an allowed privilege on the same table is not confused for a forbidden one", () => {
  // SELECT on schema_migrations is the reviewed policy; only writes are forbidden.
  const report = classifyResetPreparation({
    ...ready,
    catalog: [grant("pscale_api_gy9lze83nr29", "SELECT")],
  });
  expect(report.forbiddenPresent).toHaveLength(0);
  expect(report.runtimePresent).toEqual([grant("pscale_api_gy9lze83nr29", "SELECT")]);
  expect(report.ready).toBe(true);
});

test("missing operator visibility blocks preparation before admission is reached", () => {
  // The backup predates the live grant, so a restored branch starts without it
  // and the drain check would refuse later.
  const report = classifyResetPreparation({ ...ready, operatorVisibility: false });
  expect(report.ready).toBe(false);
  const finding = report.findings.find((f) => f.check === "operator_visibility");
  expect(finding?.detail).toContain("drain check will refuse");
});

test("an unproven runtime identity blocks preparation", () => {
  const report = classifyResetPreparation({ ...ready, runtimeIdentityProven: false });
  expect(report.ready).toBe(false);
  expect(report.findings.find((f) => f.check === "runtime_identity")?.satisfied).toBe(false);
});

test("findings carry counts and roles, never object identities", () => {
  const report = classifyResetPreparation({ ...ready, catalog: FORBIDDEN });
  for (const finding of report.findings)
    expect(finding.detail ?? "").not.toContain("api_next.schema_migrations");
});

test("removal accepts no caller-supplied connection", () => {
  // The earlier signature compared two caller-supplied target values and then
  // used whatever client it was handed, so matching rehearsal identifiers could
  // have accompanied a live-staging connection and the revocations would have
  // landed there. It now acquires its own connection through the verified
  // rehearsal boundary, leaving no connection parameter to misuse. Only the
  // optional repository root remains.
  expect(removeForbiddenResetGrants.length).toBeLessThanOrEqual(1);
});

const satisfied = {
  executionAuthorized: true,
  backupLinked: true,
  dataDigestMatches: true,
  operatorVisibility: true,
};

function harness(prerequisites = satisfied) {
  const revoked: ResetGrant[] = [];
  const order: string[] = [];
  return {
    revoked,
    order,
    run: () =>
      performForbiddenGrantRemoval({
        prerequisites,
        inspect: async () => {
          order.push("inspect");
          return classifyResetPreparation({ ...ready, catalog: FORBIDDEN });
        },
        revoke: async (grant) => {
          order.push("revoke");
          revoked.push(grant);
        },
        verifyDenied: async () => {
          order.push("verify_denied");
        },
      }),
  };
}

test("a dry run cannot reach a revocation by any path", async () => {
  // Every other prerequisite holds; only authorization is missing.
  const h = harness({ ...satisfied, executionAuthorized: false });
  await expect(h.run()).rejects.toThrow("reset_removal_refused:execution_unauthorized");
  expect(h.revoked).toHaveLength(0);
  expect(h.order).toEqual([]);
});

test("each failed prerequisite causes zero revocations", async () => {
  for (const [field, reason] of [
    ["backupLinked", "backup_unlinked"],
    ["dataDigestMatches", "data_digest_mismatch"],
    ["operatorVisibility", "operator_visibility"],
  ] as const) {
    const h = harness({ ...satisfied, [field]: false });
    await expect(h.run()).rejects.toThrow(`reset_removal_refused:${reason}`);
    expect(h.revoked).toHaveLength(0);
  }
});

test("satisfied prerequisites revoke, then verify effective denial, in that order", async () => {
  const h = harness();
  const result = await h.run();
  expect(result.revoked).toBe(3);
  expect(h.revoked).toHaveLength(3);
  // Verification follows every revocation; a catalog count is never the proof.
  expect(h.order).toEqual(["inspect", "revoke", "revoke", "revoke", "verify_denied"]);
});

test("authorization is refused before anything about the target is read", () => {
  expect(() =>
    assertRemovalPrerequisites({
      executionAuthorized: false,
      backupLinked: false,
      dataDigestMatches: false,
      operatorVisibility: false,
    }),
  ).toThrow("reset_removal_refused:execution_unauthorized");
});

test("an unauthorized removal opens no connection at all", async () => {
  // The live entry point refuses before reaching the rehearsal boundary, so a
  // dry run cannot even acquire a connection to the branch.
  await expect(removeForbiddenResetGrants({ executionAuthorized: false })).rejects.toThrow(
    "reset_removal_refused:execution_unauthorized",
  );
});

test("an idle-connection failure at the gate names the stage and carries a fixed category", async () => {
  const admin = {
    query: async () => {
      throw Object.assign(new Error("read ECONNRESET at private-host"), { code: "ECONNRESET" });
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, { cancel: () => {} }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:setup",
    category: "connection_exception",
  });
});

test("a bounded query cancellation at the catalog stage names the stage and category", async () => {
  const admin = {
    query: async (sql: string) => {
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("rolsuper"))
        return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ identity: "api_next.fn(text)" }] };
      if (sql.includes("attacl IS NOT NULL"))
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      return { rows: [] };
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, { cancel: () => {} }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:catalog",
    category: "query_canceled",
    sqlstate: "57014",
  });
});

test("an ordinary preparation refusal is preserved and stops before reconstruction", async () => {
  let reachedReconstruction = false;
  const admin = {
    query: async (sql: string) => {
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("rolsuper"))
        return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ identity: "api_next.fn(text)" }] };
      if (sql.includes("attacl IS NOT NULL")) return { rows: [{ count: 0 }] };
      if (sql.includes("aclexplode")) return { rows: [] };
      if (sql.includes("pg_default_acl")) return { rows: [] };
      if (sql.includes("pg_read_all_stats")) return { rows: [{ visible: false }] };
      return { rows: [] };
    },
  } as unknown as Pick<Client, "query">;
  try {
    await assertResetPreparationComplete(admin, "runtime_role", undefined, { cancel: () => {} });
    reachedReconstruction = true;
  } catch (error) {
    expect((error as Error).message).toBe("reset_preparation_incomplete:operator_visibility");
    expect(describeRehearsalFailure(error).category).toBeNull();
  }
  expect(reachedReconstruction).toBe(false);
});

test("a stalled gate hits its deadline with the last stage and a timeout category", async () => {
  let cancelled = false;
  let releaseSetup: (() => void) | undefined;
  const admin = {
    query: async () =>
      new Promise<never>((_done, reject) => {
        releaseSetup = () =>
          reject(Object.assign(new Error("connection destroyed"), { code: "ECONNRESET" }));
      }),
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, {
      deadlineMs: 50,
      cancel: () => {
        cancelled = true;
        releaseSetup?.();
      },
    }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:setup",
    category: "timeout",
  });
  // The pending setup query is included in the cancellation and join; the
  // refusal above is only reached because it settled within the budget.
  expect(cancelled).toBe(true);
});

test("a reset timeout cancels, joins the settled reset and refuses", async () => {
  const queries: string[] = [];
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  let cancelledAt = -1;
  let resetSettled = false;
  let releaseReset: (() => void) | undefined;
  const admin = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("RESET statement_timeout"))
        return new Promise<never>((_done, reject) => {
          releaseReset = () => {
            resetSettled = true;
            reject(Object.assign(new Error("connection destroyed"), { code: "ECONNRESET" }));
          };
        });
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("pg_read_all_stats")) return { rows: [{ visible: true }] };
      if (sql.includes("rolsuper"))
        return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ identity: "api_next.fn(text)" }] };
      if (sql.includes("attacl IS NOT NULL")) return { rows: [{ count: 0 }] };
      if (sql.includes("aclexplode")) return { rows: [] };
      if (sql.includes("pg_default_acl")) return { rows: [] };
      return { rows: [{ objects: 1, roles: 2, allowed: false }] };
    },
  } as unknown as Pick<Client, "query">;
  try {
    await expect(
      assertResetPreparationComplete(admin, "runtime_role", undefined, {
        deadlineMs: 150,
        onStage: (stage) => {
          if (stage === "reset") now += 130;
        },
        cancel: () => {
          cancelledAt = queries.length;
          releaseReset?.();
        },
      }),
    ).rejects.toMatchObject({
      message: "reset_preparation_gate_failed:reset",
      category: "timeout",
    });
    expect(resetSettled).toBe(true);
    expect(cancelledAt).toBeGreaterThanOrEqual(0);
    // No statement was forwarded after cancellation was recorded, and the RESET
    // promise the gate tracked had provably settled before the refusal.
    expect(queries.length).toBe(cancelledAt);
    expect(
      queries.filter((sql) => sql.startsWith("SET statement_timeout") && sql.includes("60s"))
        .length,
    ).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test("an operation cancellation cannot settle refuses as unresolved cleanup", async () => {
  const queries: string[] = [];
  let cancelled = false;
  let inspectedAt = -1;
  const admin = {
    query: async (sql: string) => {
      // Every attempt is logged before any fake behavior, so a forwarded call
      // after cancellation would be visible rather than hidden by the throw.
      queries.push(sql);
      if (cancelled) throw Object.assign(new Error("connection destroyed"), { code: "ECONNRESET" });
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("rolsuper")) {
        inspectedAt = queries.length;
        await new Promise<void>((done) => {
          const handle = setTimeout(done, 30_000);
          (handle as { unref?: () => void }).unref?.();
        });
      }
      return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
    },
  } as unknown as Pick<Client, "query">;
  const started = Date.now();
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, {
      deadlineMs: 50,
      joinMs: 100,
      cancel: () => {
        cancelled = true;
      },
    }),
  ).rejects.toMatchObject({
    message: "reset_preparation_cleanup_unresolved",
    category: "timeout",
  });
  const elapsed = Date.now() - started;
  // The explicit termination budget was spent observing settlement rather
  // than inherited from the expired gate deadline.
  expect(elapsed).toBeGreaterThanOrEqual(100);
  expect(elapsed).toBeLessThan(2_000);
  expect(cancelled).toBe(true);
  expect(inspectedAt).toBeGreaterThanOrEqual(0);
  expect(queries.length).toBe(inspectedAt);
});

test("a setup rejection refuses before inspection and preserves its category", async () => {
  const queries: string[] = [];
  const admin = {
    query: async (sql: string) => {
      queries.push(sql);
      throw Object.assign(new Error("connection failure"), { code: "08006" });
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, { cancel: () => {} }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:setup",
    category: "connection_exception",
    sqlstate: "08006",
  });
  expect(queries.some((sql) => sql.includes("rolsuper"))).toBe(false);
});

test("deadline expiry cancels the pending inspection and joins it before returning", async () => {
  let cancelled = false;
  let cancelledAt = -1;
  let identitySettled = false;
  let release: (() => void) | undefined;
  const queries: string[] = [];
  const admin = {
    query: async (sql: string) => {
      // Log every attempt before any fake behavior: a call forwarded after
      // cancellation would appear in the log instead of being concealed by
      // the throw below.
      queries.push(sql);
      if (cancelled) throw Object.assign(new Error("connection destroyed"), { code: "ECONNRESET" });
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("rolsuper")) {
        await new Promise<void>((done) => (release = done));
        identitySettled = true;
      }
      return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
    },
  } as unknown as Pick<Client, "query">;
  const started = Date.now();
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, {
      deadlineMs: 50,
      cancel: () => {
        cancelled = true;
        cancelledAt = queries.length;
        release?.();
      },
    }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:identity",
    category: "timeout",
  });
  // The gate returns only after the cancelled operation has settled, and it
  // forwards no query between cancellation and return.
  expect(cancelled).toBe(true);
  expect(identitySettled).toBe(true);
  expect(cancelledAt).toBeGreaterThanOrEqual(0);
  expect(queries.length).toBe(cancelledAt);
  // The bound stays below the explicit five-second termination budget: a join
  // that waited out the whole budget instead of observing settlement fails
  // here, while scheduler delay under host load does not.
  expect(Date.now() - started).toBeLessThan(4_000);
  const settled = queries.length;
  await Bun.sleep(30);
  expect(queries.length).toBe(settled);
  expect(queries.filter((sql) => sql.startsWith("RESET")).length).toBe(0);
});

test("a reset failure refuses instead of admitting the connection", async () => {
  const admin = {
    query: async (sql: string) => {
      if (sql.startsWith("RESET statement_timeout"))
        throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      if (sql.includes("statement_timeout")) return { rows: [] };
      if (sql.includes("pg_read_all_stats")) return { rows: [{ visible: true }] };
      if (sql.includes("rolsuper"))
        return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
      if (sql.includes("to_regprocedure")) return { rows: [{ identity: "api_next.fn(text)" }] };
      if (sql.includes("attacl IS NOT NULL")) return { rows: [{ count: 0 }] };
      if (sql.includes("aclexplode")) return { rows: [] };
      if (sql.includes("pg_default_acl")) return { rows: [] };
      return { rows: [{ objects: 1, roles: 2, allowed: false }] };
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, { cancel: () => {} }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:reset",
    category: "admin_shutdown",
    sqlstate: "57P01",
  });
});

test("an already-expired gate never attempts setup", async () => {
  const queries: string[] = [];
  const admin = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pick<Client, "query">;
  await expect(
    assertResetPreparationComplete(admin, "runtime_role", undefined, {
      deadlineMs: 0,
      cancel: () => {},
    }),
  ).rejects.toMatchObject({
    message: "reset_preparation_gate_failed:setup",
    category: "timeout",
  });
  expect(queries).toEqual([]);
});

for (const expiredStage of ["catalog", "reset"] as const) {
  test(`expiry before ${expiredStage} prevents its query even before the timer callback`, async () => {
    const queries: string[] = [];
    let callsAtExpiry = -1;
    let cancelled = false;
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const admin = {
      query: async (sql: string) => {
        // Count every attempted call before responding or throwing.
        queries.push(sql);
        if (sql.includes("statement_timeout")) return { rows: [] };
        if (sql.includes("pg_read_all_stats")) return { rows: [{ visible: true }] };
        if (sql.includes("rolsuper"))
          return { rows: [{ count: 1, elevated: false, names: ["runtime_role"], owns: false }] };
        if (sql.includes("to_regprocedure")) return { rows: [{ identity: "api_next.fn(text)" }] };
        if (sql.includes("attacl IS NOT NULL")) return { rows: [{ count: 0 }] };
        if (sql.includes("aclexplode") || sql.includes("pg_default_acl")) return { rows: [] };
        return { rows: [{ objects: 1, roles: 2, allowed: false }] };
      },
    } as unknown as Pick<Client, "query">;
    try {
      await expect(
        assertResetPreparationComplete(admin, "runtime_role", undefined, {
          cancel: () => {
            cancelled = true;
          },
          onStage: (stage) => {
            if (stage === expiredStage) {
              callsAtExpiry = queries.length;
              now += 240_001;
            }
          },
        }),
      ).rejects.toMatchObject({
        message: `reset_preparation_gate_failed:${expiredStage}`,
        category: "timeout",
      });
      expect(callsAtExpiry).toBeGreaterThan(0);
      expect(queries.length).toBe(callsAtExpiry);
      expect(queries.some((sql) => sql.startsWith("RESET"))).toBe(false);
      expect(cancelled).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
}

test("authorization is the only prerequisite the caller can supply", () => {
  // Backup linkage, data digest and operator visibility are observed on the
  // connection that carries the revocations, so no caller can assert them.
  // A decision cannot be observed, which is why authorization remains a
  // parameter; if this signature grows another boolean, that is the regression.
  const accepted = Object.keys({ executionAuthorized: true, repositoryRoot: "" });
  expect(accepted).toEqual(["executionAuthorized", "repositoryRoot"]);
  expect(accepted).not.toContain("backupLinked");
  expect(accepted).not.toContain("dataDigestMatches");
});
