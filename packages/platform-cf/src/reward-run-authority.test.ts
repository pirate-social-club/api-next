import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import {
  makeControlPlaneRewardRunAuthority,
  preparedTransactionLanded,
} from "./reward-operations-control.ts";

const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => "granted"),
      Effect.catch((error) => Effect.succeed((error as { _tag: string })._tag)),
    ),
  );

function database(answer: (statement: ControlPlaneStatement) => Effect.Effect<unknown, unknown>) {
  const statements: ControlPlaneStatement[] = [];
  const execute = (statement: ControlPlaneStatement) => {
    statements.push(statement);
    return answer(statement).pipe(Effect.as({ rows: [], rowCount: 1 }));
  };
  const layer = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: () => Effect.die("authority is asked in one statement"),
  } as unknown as ControlPlaneDb["Service"]);
  return { statements, authority: makeControlPlaneRewardRunAuthority(layer) };
}
const failure = (sqlState: string | null) =>
  new ControlPlaneStatementFailed({
    label: "reward-run-authority.require",
    sqlState,
    constraint: null,
    outcomeCertainty: "completed",
  });

describe("run authority from the database", () => {
  test("is one writable statement that completes before the caller acts", async () => {
    const db = database(() => Effect.void);
    expect(await outcome(db.authority.ensure())).toBe("granted");
    expect(db.statements).toEqual([
      {
        label: "reward-run-authority.require",
        text: "SELECT require_reward_run_authority_v1()",
        values: [],
        readonly: false,
      },
    ]);
  });

  test("a refusal by the lease or the brake is a deliberate hold", async () => {
    const db = database(() => Effect.fail(failure("PR001")));
    expect(await outcome(db.authority.ensure())).toBe("RewardOperationsPaused");
  });

  test("any other failure to get an answer refuses as an incident, never as a grant", async () => {
    for (const error of [failure("57014"), failure(null), new Error("connection lost")]) {
      const db = database(() => Effect.fail(error));
      expect(await outcome(db.authority.ensure())).toBe("RewardRunAuthorityUnavailable");
    }
  });
});

describe("whether a stored signature already reached the chain", () => {
  const landed = (readReceipt: () => Promise<unknown>) =>
    Effect.runPromise(preparedTransactionLanded({ readReceipt }, `0x${"a".repeat(64)}`));
  test("only a receipt is evidence that it did", async () => {
    expect(await landed(async () => ({ status: "success" }))).toBe(true);
    expect(await landed(async () => ({ status: "reverted" }))).toBe(true);
  });
  test("a missing receipt or a failed read proves nothing and answers false", async () => {
    expect(await landed(async () => null)).toBe(false);
    expect(await landed(async () => undefined)).toBe(false);
    expect(
      await landed(async () => {
        throw new Error("rpc unavailable");
      }),
    ).toBe(false);
  });
});

// Every place that signs, sends or publishes for rewards. A new call site that
// does not ask for authority immediately beforehand fails here.
const coordinators: ReadonlyArray<
  Readonly<{ file: string; signs: number; dispatches: number; landedChecks: number }>
> = [
  { file: "reward-token-send-coordinator.ts", signs: 1, dispatches: 1, landedChecks: 1 },
  { file: "megapot-purchase-coordinator.ts", signs: 1, dispatches: 1, landedChecks: 1 },
  // Approval signs on a resumed reservation and on a new one.
  { file: "megapot-approval-coordinator.ts", signs: 2, dispatches: 1, landedChecks: 1 },
  { file: "megapot-claim-coordinator.ts", signs: 1, dispatches: 1, landedChecks: 1 },
  { file: "reward-gas-topup-coordinator.ts", signs: 1, dispatches: 1, landedChecks: 1 },
  // A commitment is published to storage, not sent to the chain.
  { file: "megapot-commitment-coordinator.ts", signs: 1, dispatches: 1, landedChecks: 0 },
];
const authorityCall = "yield* input.authority.ensure();";

describe("every rewards signature and dispatch asks for authority first", () => {
  for (const coordinator of coordinators)
    test(coordinator.file, () => {
      const source = readFileSync(new URL(coordinator.file, import.meta.url), "utf8");
      const sites = (pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match.index);
      const signs = sites(/\bsigner\.sign\(/g);
      const dispatches = sites(/\b(?:rpc\.sendRawTransaction|publisher\.publish)\(/g);
      expect(signs).toHaveLength(coordinator.signs);
      expect(dispatches).toHaveLength(coordinator.dispatches);
      for (const site of [...signs, ...dispatches]) {
        const asked = source.lastIndexOf(authorityCall, site);
        expect(asked).toBeGreaterThan(-1);
        // Nothing else is awaited between the answer and the call it authorizes:
        // the only yield in between is the statement that makes the call.
        const between = source.slice(asked + authorityCall.length, site);
        expect(between.match(/yield\*/g) ?? []).toHaveLength(1);
        expect(between.split("\n").length).toBeLessThan(12);
      }
      // The check before a send sits outside the handling of an uncertain broadcast.
      for (const site of dispatches) {
        const asked = source.lastIndexOf(authorityCall, site);
        expect(source.slice(asked, site)).not.toMatch(/Effect\.catch|catch:/);
      }
      expect(sites(/preparedTransactionLanded\(/g)).toHaveLength(coordinator.landedChecks);
    });

  test("a stored signature is looked for on chain before any fresh-send check", () => {
    for (const coordinator of coordinators.filter((entry) => entry.landedChecks > 0)) {
      const source = readFileSync(new URL(coordinator.file, import.meta.url), "utf8");
      const submit = source.indexOf("const submitPrepared");
      const guard = source.indexOf(
        '.state !== "prepared") return yield* reconcilePrepared(',
        submit,
      );
      const landed = source.indexOf("preparedTransactionLanded(", submit);
      const send = source.indexOf("sendRawTransaction(", submit);
      expect(submit).toBeGreaterThan(-1);
      expect(guard).toBeGreaterThan(submit);
      expect(landed).toBeGreaterThan(guard);
      expect(send).toBeGreaterThan(landed);
      // It is the first thing awaited after the state guard.
      expect(source.slice(guard, landed).match(/yield\*/g) ?? []).toHaveLength(2);
    }
  });
});
