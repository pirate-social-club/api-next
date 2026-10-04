import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const ORGANIZATION = "piratesocialclub";
const DATABASE = "staging";
const DATABASE_ID = "yk4dth90j7px";
const PARENT_ID = "ojbnlrgihio8";
const CLUSTER = "PS_5_AWS_ARM";
const ENDPOINT = `organizations/${ORGANIZATION}/databases/${DATABASE}`;

export type BranchProvider = {
  database(): Promise<unknown>;
  branch(name: string): Promise<unknown | null>;
  create(body: Readonly<Record<string, string | number>>): Promise<unknown>;
};
export type ProvisionJournal = {
  reserve(plan: unknown): void;
  submitted(branchId: string): void;
  finish(outcome: unknown): void;
};
export type BranchCommand = {
  readonly branch: string;
  readonly execute: boolean;
  readonly receipt: string | undefined;
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("branch_provider_response_invalid");
  }
  return value as Record<string, unknown>;
}

export function parseBranchCommand(args: readonly string[]): BranchCommand {
  const [branch, ...flags] = args;
  if (!branch || !/^rewards-runner-[0-9]{8}$/u.test(branch)) {
    throw new Error("Use an isolated branch named rewards-runner-YYYYMMDD");
  }
  let execute = false;
  let receipt: string | undefined;
  for (const flag of flags) {
    if (flag === "--execute" && !execute) execute = true;
    else if (flag.startsWith("--receipt=") && receipt === undefined) {
      receipt = flag.slice("--receipt=".length);
      if (!isAbsolute(receipt)) throw new Error("Receipt path must be absolute");
    } else throw new Error("Unknown or repeated branch provisioning option");
  }
  if (execute && receipt === undefined)
    throw new Error("--execute requires --receipt=/absolute/path");
  return { branch, execute, receipt };
}

/** Only a verified single-node receipt may precede role or binding provisioning. */
export async function provisionRewardsBranch(
  command: BranchCommand,
  provider: BranchProvider,
  journal: ProvisionJournal,
  wait: () => Promise<void>,
  attempts = 120,
) {
  // Validate exported-function callers as well as CLI input.
  parseBranchCommand([
    command.branch,
    ...(command.execute ? ["--execute"] : []),
    ...(command.receipt === undefined ? [] : [`--receipt=${command.receipt}`]),
  ]);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120)
    throw new Error("rewards_branch_poll_budget_invalid");
  const database = object(await provider.database());
  if (database.id !== DATABASE_ID || database.name !== DATABASE || database.kind !== "postgresql") {
    throw new Error("rewards_branch_database_identity_mismatch");
  }
  const parent = object(await provider.branch("main"));
  if (parent.id !== PARENT_ID || parent.name !== "main" || parent.ready !== true) {
    throw new Error("rewards_branch_parent_identity_mismatch");
  }
  if ((await provider.branch(command.branch)) !== null) {
    throw new Error("rewards_branch_already_exists");
  }
  const body = {
    name: command.branch,
    parent_branch: "main",
    cluster_size: CLUSTER,
    replicas: 0,
    major_version: "17",
  } as const;
  const plan = { organization: ORGANIZATION, database: DATABASE, databaseId: DATABASE_ID, body };
  if (!command.execute) return { dryRun: true, ...plan };

  // Persist exclusive intent before POST. Failed/uncertain attempts retain it.
  journal.reserve(plan);
  let createdId: string | undefined;
  try {
    const created = object(await provider.create(body));
    if (
      typeof created.id !== "string" ||
      !/^[a-z0-9]{1,32}$/u.test(created.id) ||
      created.name !== command.branch
    )
      throw new Error("rewards_branch_creation_identity_unproven");
    createdId = created.id;
    journal.submitted(createdId);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const observed = object(await provider.branch(command.branch));
      if (
        observed.id !== createdId ||
        observed.name !== command.branch ||
        observed.kind !== "postgresql" ||
        observed.parent_branch !== "main"
      )
        throw new Error("rewards_branch_readback_identity_mismatch");
      if (observed.replicas !== 0 || observed.cluster_name !== CLUSTER) {
        throw new Error("rewards_branch_single_node_readback_refused");
      }
      if (observed.ready === true && observed.state === "ready") {
        const receipt = {
          dryRun: false,
          organization: ORGANIZATION,
          database: DATABASE,
          databaseId: DATABASE_ID,
          parentBranchId: PARENT_ID,
          branchId: createdId,
          branchName: command.branch,
          clusterName: CLUSTER,
          replicas: 0,
          ready: true,
          verifiedAt: new Date().toISOString(),
        } as const;
        journal.finish(receipt);
        return receipt;
      }
      if (attempt + 1 < attempts) await wait();
    }
    throw new Error("rewards_branch_readiness_unproven");
  } catch (error) {
    // Never create again, delete a branch, or create roles as compensation.
    try {
      journal.finish({
        dryRun: false,
        verified: false,
        branchName: command.branch,
        branchId: createdId ?? null,
      });
    } catch {
      // The exclusive intent still fences another creation if receipt persistence fails.
    }
    throw error;
  }
}

/** Metadata only: managed CLI auth stays unchanged and provider errors are redacted. */
export function makeBranchProvider(): BranchProvider {
  function api(
    path: string,
    fields?: Readonly<Record<string, string | number>>,
  ): Promise<unknown | null> {
    const args = ["api", path, "--format", "json", "--method", fields ? "POST" : "GET"];
    for (const [name, value] of Object.entries(fields ?? {})) {
      args.push("--field", `${name}=${JSON.stringify(value)}`);
    }
    return new Promise((resolve, reject) => {
      execFile("pscale", args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        let response: unknown;
        try {
          response = JSON.parse(stdout);
        } catch {
          reject(new Error("branch_provider_response_invalid"));
          return;
        }
        if (error) {
          let failure: Record<string, unknown>;
          try {
            failure = object(response);
          } catch {
            reject(new Error("branch_provider_response_invalid"));
            return;
          }
          if (
            !fields &&
            ((failure.status === 404 && failure.error === "Not Found") ||
              (failure.code === "not_found" && failure.message === "Not Found"))
          )
            resolve(null);
          else reject(new Error("branch_provider_request_unproven"));
        } else resolve(response);
      });
    });
  }
  return {
    database: () => api(ENDPOINT),
    branch: (name) => api(`${ENDPOINT}/branches/${encodeURIComponent(name)}`),
    create: (body) => api(`${ENDPOINT}/branches`, body),
  };
}

export function makeProvisionJournal(receipt: string): ProvisionJournal {
  const intent = `${receipt}.intent.json`;
  return {
    reserve(plan) {
      if (existsSync(receipt) || existsSync(`${receipt}.submitted.json`)) {
        throw new Error("rewards_branch_receipt_already_exists");
      }
      writeFileSync(intent, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    },
    submitted(branchId) {
      writeFileSync(`${receipt}.submitted.json`, `${JSON.stringify({ branchId })}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    },
    finish(outcome) {
      writeFileSync(receipt, `${JSON.stringify(outcome, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    },
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) {
    console.log(
      "bun scripts/rewards-e2e/provision-branch.ts rewards-runner-YYYYMMDD [--execute --receipt=/absolute/path.json]",
    );
    console.log(
      "Defaults to a read-only plan. Execution creates once and requires ready PS-5/zero-replica readback. Inspect retained intent before any failed-attempt recovery.",
    );
  } else {
    try {
      const command = parseBranchCommand(process.argv.slice(2));
      const journal = makeProvisionJournal(command.receipt ?? "/unused-dry-run-receipt");
      const result = await provisionRewardsBranch(
        command,
        makeBranchProvider(),
        journal,
        () => new Promise((resolve) => setTimeout(resolve, 3_000)),
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : "rewards_branch_provisioning_unproven",
      );
      process.exitCode = 1;
    }
  }
}
