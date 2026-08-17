import { createHash } from "node:crypto";

import { ControlPlaneDb } from "@pirate/application";
import { IdentityAccountDocument } from "@pirate/application/use-cases/identity-account";
import { makeControlPlaneIdentityRepository } from "@pirate/platform-cf/identity-repository";
import { makeDirectPostgresControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect, Schema } from "effect";

const RUNTIME_DSN_ENV = "CONTROL_PLANE_POSTGRES_RUNTIME_URL" as const;
const ENVIRONMENT_ENV = "API_NEXT_ENV" as const;

const BootstrapInput = Schema.Struct({
  user_id: Schema.String,
  account: IdentityAccountDocument,
});

type BootstrapInput = Schema.Schema.Type<typeof BootstrapInput>;

export type StagingIdentityBootstrapResult = {
  readonly environment: "staging";
  readonly mode: "dry-run" | "apply";
  readonly action: "validated" | "applied";
  readonly user_id_sha256: string;
};

export type StagingIdentityBootstrapWriter = {
  readonly upsertAccount: (input: {
    readonly userId: string;
    readonly account: unknown;
  }) => Effect.Effect<void, unknown>;
};

export type StagingIdentityBootstrapOptions = {
  /** Tests may provide a no-environment writer; production uses the reviewed repository below. */
  readonly repository?: StagingIdentityBootstrapWriter;
  /** Tests may provide input without reading a process stream. */
  readonly inputText?: string;
  /** Tests may provide a controlled environment snapshot. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

export class StagingIdentityBootstrapError extends Error {
  readonly code:
    | "not-staging"
    | "invalid-options"
    | "missing-runtime-dsn"
    | "invalid-input"
    | "apply-failed";

  constructor(code: StagingIdentityBootstrapError["code"], message: string) {
    super(message);
    this.name = "StagingIdentityBootstrapError";
    this.code = code;
  }
}

function environmentOf(
  options: StagingIdentityBootstrapOptions,
): Readonly<Record<string, string | undefined>> {
  return options.environment ?? process.env;
}

function assertStagingEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  if (environment[ENVIRONMENT_ENV] !== "staging") {
    throw new StagingIdentityBootstrapError(
      "not-staging",
      "Identity bootstrap is refused unless API_NEXT_ENV=staging.",
    );
  }
}

function parseOptions(args: readonly string[]): {
  readonly apply: boolean;
  readonly inputPath?: string;
} {
  let apply = false;
  let inputPath: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--confirm-staging") {
      // Confirmation is checked after parsing so argument order is irrelevant.
    } else if (argument === "--input") {
      const path = args[index + 1];
      if (path === undefined || path.startsWith("--")) {
        throw new StagingIdentityBootstrapError(
          "invalid-options",
          "--input requires a file path; omit it to read JSON from stdin.",
        );
      }
      inputPath = path;
      index += 1;
    } else {
      throw new StagingIdentityBootstrapError(
        "invalid-options",
        "Unknown option. Use --dry-run, --input PATH, or --apply --confirm-staging.",
      );
    }
  }

  if (apply && dryRun) {
    throw new StagingIdentityBootstrapError(
      "invalid-options",
      "Choose one mode: --dry-run (the default) or --apply.",
    );
  }
  if (apply && !args.includes("--confirm-staging")) {
    throw new StagingIdentityBootstrapError(
      "invalid-options",
      "Applying requires the explicit --confirm-staging acknowledgement.",
    );
  }
  if (!apply && args.includes("--confirm-staging")) {
    throw new StagingIdentityBootstrapError(
      "invalid-options",
      "--confirm-staging is only valid with --apply.",
    );
  }

  return inputPath === undefined ? { apply } : { apply, inputPath };
}

async function readInput(
  inputPath: string | undefined,
  suppliedInput: string | undefined,
): Promise<string> {
  if (suppliedInput !== undefined) return suppliedInput;
  if (inputPath === undefined || inputPath === "-") return Bun.stdin.text();
  try {
    return await Bun.file(inputPath).text();
  } catch {
    throw new StagingIdentityBootstrapError("invalid-input", "Unable to read bootstrap input.");
  }
}

function parseInput(serialized: string): BootstrapInput {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new StagingIdentityBootstrapError("invalid-input", "Bootstrap input is not valid JSON.");
  }

  try {
    const input = Schema.decodeUnknownSync(BootstrapInput)(value);
    const { account, user_id: userId } = input;
    const label = account.global_handle.label_display;
    const normalizedLabel = label.trim().toLowerCase();
    const labelIsPersistable =
      [...label].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code <= 0x7f && code !== 0x7f;
      }) &&
      normalizedLabel.endsWith(".pirate") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*\.pirate$/u.test(normalizedLabel) &&
      normalizedLabel.length - ".pirate".length <= 32;

    if (
      userId.length === 0 ||
      userId !== userId.trim() ||
      userId.includes("\u0000") ||
      account.user.user_id !== userId ||
      account.profile.user_id !== userId ||
      account.profile.global_handle_id !== account.global_handle.global_handle_id ||
      account.global_handle.status !== "active" ||
      !labelIsPersistable ||
      !Number.isFinite(Date.parse(account.user.created_at))
    ) {
      throw new Error("semantic validation failed");
    }
    return input;
  } catch {
    throw new StagingIdentityBootstrapError(
      "invalid-input",
      "Bootstrap input failed IdentityAccountDocument validation.",
    );
  }
}

function identifierDigest(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

export async function runStagingIdentityBootstrap(
  args: readonly string[] = [],
  options: StagingIdentityBootstrapOptions = {},
): Promise<StagingIdentityBootstrapResult> {
  const environment = environmentOf(options);
  assertStagingEnvironment(environment);
  const parsed = parseOptions(args);
  const input = parseInput(await readInput(parsed.inputPath, options.inputText));
  const digest = identifierDigest(input.user_id);

  if (!parsed.apply) {
    return {
      environment: "staging",
      mode: "dry-run",
      action: "validated",
      user_id_sha256: digest,
    };
  }

  const runtimeDsn = environment[RUNTIME_DSN_ENV]?.trim();
  if (runtimeDsn === undefined || runtimeDsn.length === 0) {
    throw new StagingIdentityBootstrapError(
      "missing-runtime-dsn",
      `${RUNTIME_DSN_ENV} is required for --apply and is never printed.`,
    );
  }

  try {
    if (options.repository !== undefined) {
      await Effect.runPromise(
        options.repository.upsertAccount({ userId: input.user_id, account: input.account }),
      );
    } else {
      const repository = makeControlPlaneIdentityRepository();
      const write = repository.upsertAccount({ userId: input.user_id, account: input.account });
      const program = Effect.gen(function* () {
        yield* ControlPlaneDb;
        yield* write;
      }).pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(runtimeDsn)));
      await Effect.runPromise(Effect.scoped(program));
    }
  } catch {
    throw new StagingIdentityBootstrapError(
      "apply-failed",
      "Identity bootstrap apply failed; inspect the database through the approved operational runbook.",
    );
  }

  return {
    environment: "staging",
    mode: "apply",
    action: "applied",
    user_id_sha256: digest,
  };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const result = await runStagingIdentityBootstrap(args);
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof StagingIdentityBootstrapError ? error.message : "Identity bootstrap failed.",
    );
    process.exitCode = 1;
  });
}
