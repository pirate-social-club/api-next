const FIXTURE_ID = /^community-very-staging-fixture-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type VeryStagingFixtureAction = "seed" | "deactivate";
export type VeryStagingFixtureMode = "dry-run" | "apply";

export type VeryStagingFixtureOptions = Readonly<{
  readonly action: VeryStagingFixtureAction;
  readonly mode: VeryStagingFixtureMode;
  readonly communityId: string;
  readonly operatorUserId: string;
  readonly connectionString: string;
}>;

export type VeryStagingFixtureResult = Readonly<{
  readonly environment: "staging";
  readonly action: VeryStagingFixtureAction;
  readonly mode: VeryStagingFixtureMode;
  readonly status:
    | "would_seed"
    | "seeded"
    | "already_seeded"
    | "would_deactivate"
    | "deactivated"
    | "already_deactivated";
  readonly community_id: string;
  readonly operator_user_id: string;
  readonly append_only_policy_rows_retained: boolean;
}>;

export function veryStagingFixtureResult(
  options: VeryStagingFixtureOptions,
  status: VeryStagingFixtureResult["status"],
): VeryStagingFixtureResult {
  return {
    environment: "staging",
    action: options.action,
    mode: options.mode,
    status,
    community_id: options.communityId,
    operator_user_id: options.operatorUserId,
    append_only_policy_rows_retained: options.action === "deactivate",
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

export class VeryStagingFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VeryStagingFixtureError";
  }
}

function requireValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new VeryStagingFixtureError(`${option} requires a value.`);
  }
  return value;
}

export function parseVeryStagingFixtureOptions(
  args: readonly string[],
  environment: Environment = process.env,
): VeryStagingFixtureOptions {
  if (environment.API_NEXT_ENV !== "staging") {
    throw new VeryStagingFixtureError("Refusing to run unless API_NEXT_ENV=staging.");
  }
  const action = args[0];
  if (action !== "seed" && action !== "deactivate") {
    throw new VeryStagingFixtureError(
      "Usage: bun scripts/very-staging-community-fixture.ts <seed|deactivate> --community-id ID --operator-user-id ID [--dry-run|--apply --confirm-staging]",
    );
  }

  let communityId: string | undefined;
  let operatorUserId: string | undefined;
  let apply = false;
  let dryRun = false;
  let confirmStaging = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--community-id") {
      communityId = requireValue(args, index, argument);
      index += 1;
    } else if (argument === "--operator-user-id") {
      operatorUserId = requireValue(args, index, argument);
      index += 1;
    } else if (argument === "--apply") {
      apply = true;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--confirm-staging") {
      confirmStaging = true;
    } else {
      throw new VeryStagingFixtureError(`Unknown option: ${argument ?? ""}`);
    }
  }

  if (apply && dryRun) {
    throw new VeryStagingFixtureError("Choose either --dry-run or --apply.");
  }
  if (apply !== confirmStaging) {
    throw new VeryStagingFixtureError(
      apply
        ? "Applying requires --confirm-staging."
        : "--confirm-staging is only valid with --apply.",
    );
  }
  if (communityId === undefined || !FIXTURE_ID.test(communityId) || communityId.length > 128) {
    throw new VeryStagingFixtureError(
      "--community-id must start with community-very-staging-fixture- and use lowercase letters, numbers, and hyphens.",
    );
  }
  if (
    operatorUserId === undefined ||
    operatorUserId !== operatorUserId.trim() ||
    operatorUserId.includes("\u0000") ||
    operatorUserId.length > 256
  ) {
    throw new VeryStagingFixtureError("--operator-user-id must be a non-empty persisted user id.");
  }
  const connectionString = environment.CONTROL_PLANE_POSTGRES_ADMIN_URL?.trim();
  if (!connectionString) {
    throw new VeryStagingFixtureError("CONTROL_PLANE_POSTGRES_ADMIN_URL is required.");
  }
  return {
    action,
    mode: apply ? "apply" : "dry-run",
    communityId,
    operatorUserId,
    connectionString,
  };
}
