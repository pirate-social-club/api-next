import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BranchProvider,
  makeProvisionJournal,
  parseBranchCommand,
  provisionRewardsBranch,
} from "./provision-branch";

const name = "rewards-runner-20991231";
const ready = {
  id: "newbranch123",
  name,
  kind: "postgresql",
  parent_branch: "main",
  replicas: 0,
  cluster_name: "PS_5_AWS_ARM",
  ready: true,
  state: "ready",
};
function fixture(observed: unknown = ready) {
  const bodies: unknown[] = [];
  const outcomes: unknown[] = [];
  let created = false;
  const provider: BranchProvider = {
    database: async () => ({ id: "yk4dth90j7px", name: "staging", kind: "postgresql" }),
    branch: async (branch) =>
      branch === "main"
        ? { id: "ojbnlrgihio8", name: "main", ready: true }
        : created
          ? observed
          : null,
    create: async (body) => {
      bodies.push(body);
      created = true;
      return { id: ready.id, name };
    },
  };
  const journal = {
    reserve: (_plan: unknown) => {},
    submitted: (_id: string) => {},
    finish: (outcome: unknown) => {
      outcomes.push(outcome);
    },
  };
  const command = parseBranchCommand([name, "--execute", "--receipt=/tmp/fixture.json"]);
  return { provider, journal, command, bodies, outcomes };
}

describe("Rewards branch cost guard", () => {
  test("creation explicitly requests zero replicas and PS-5 and independently verifies readiness", async () => {
    const f = fixture();
    const result = await provisionRewardsBranch(f.command, f.provider, f.journal, async () => {});
    expect(f.bodies).toEqual([
      {
        name,
        parent_branch: "main",
        cluster_size: "PS_5_AWS_ARM",
        replicas: 0,
        major_version: "17",
      },
    ]);
    expect(result).toMatchObject({ branchId: ready.id, replicas: 0, ready: true, dryRun: false });
    expect(f.outcomes).toEqual([result]);
  });
  test("default dry run neither creates nor reserves a journal", async () => {
    const f = fixture();
    f.journal.reserve = () => {
      throw new Error("unexpected journal mutation");
    };
    const result = await provisionRewardsBranch(
      parseBranchCommand([name]),
      f.provider,
      f.journal,
      async () => {},
    );
    expect(result.dryRun).toBe(true);
    expect(f.bodies).toHaveLength(0);
    expect(f.outcomes).toHaveLength(0);
  });
  for (const [label, patch] of [
    ["replicas", { replicas: 2 }],
    ["missing replicas", { replicas: undefined }],
    ["string replicas", { replicas: "0" }],
    ["larger cluster", { cluster_name: "PS_10_AWS_ARM" }],
    ["changed identity", { id: "different" }],
    ["wrong parent", { parent_branch: "other" }],
  ] as const) {
    test(`refuses ${label} after a single creation`, async () => {
      const f = fixture({ ...ready, ...patch });
      await expect(
        provisionRewardsBranch(f.command, f.provider, f.journal, async () => {}),
      ).rejects.toThrow();
      expect(f.bodies).toHaveLength(1);
      expect(f.outcomes).toEqual([
        { dryRun: false, verified: false, branchName: name, branchId: ready.id },
      ]);
    });
  }
  test("waits for provider readiness without recreating", async () => {
    const f = fixture({ ...ready, ready: false, state: "pending" });
    let waits = 0;
    const initial = f.provider.branch;
    f.provider.branch = async (branch) =>
      waits > 0 && branch !== "main" ? ready : initial(branch);
    await provisionRewardsBranch(
      f.command,
      f.provider,
      f.journal,
      async () => {
        waits++;
      },
      2,
    );
    expect(waits).toBe(1);
    expect(f.bodies).toHaveLength(1);
  });
  test("timeout refuses unproven readiness", async () => {
    const f = fixture({ ...ready, ready: false, state: "pending" });
    await expect(
      provisionRewardsBranch(f.command, f.provider, f.journal, async () => {}, 1),
    ).rejects.toThrow("readiness_unproven");
  });
  for (const condition of ["database", "parent", "existing"] as const) {
    test(`refuses ${condition} before creating`, async () => {
      const f = fixture();
      if (condition === "database")
        f.provider.database = async () => ({ id: "other", name: "staging", kind: "postgresql" });
      else
        f.provider.branch = async (branch) =>
          condition === "parent"
            ? { id: "other", name: "main", ready: true }
            : branch === "main"
              ? { id: "ojbnlrgihio8", name: "main", ready: true }
              : ready;
      await expect(
        provisionRewardsBranch(f.command, f.provider, f.journal, async () => {}),
      ).rejects.toThrow();
      expect(f.bodies).toHaveLength(0);
    });
  }
  test("an uncertain creation leaves private intent and prevents a second POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rewards-cost-guard-"));
    try {
      const receipt = join(dir, "receipt.json");
      const f = fixture();
      let posts = 0;
      f.provider.create = async () => {
        posts++;
        throw new Error("lost response");
      };
      const command = parseBranchCommand([name, "--execute", `--receipt=${receipt}`]);
      await expect(
        provisionRewardsBranch(command, f.provider, makeProvisionJournal(receipt), async () => {}),
      ).rejects.toThrow("lost response");
      expect(statSync(`${receipt}.intent.json`).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
        verified: false,
        branchId: null,
      });
      await expect(
        provisionRewardsBranch(command, f.provider, makeProvisionJournal(receipt), async () => {}),
      ).rejects.toThrow("already_exists");
      expect(posts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  test("rejects shared names and execution without a receipt", () => {
    for (const args of [
      ["main"],
      [name, "--execute"],
      [name, "--execute", "--receipt=relative"],
      [name, "--execute", "--execute"],
    ])
      expect(() => parseBranchCommand(args)).toThrow();
  });
});
