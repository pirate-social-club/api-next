import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type CommunityCreationEvidence = Readonly<{
  target: string;
  outputSha256: string;
  recordedAt: string;
}>;

/** The reviewed E2E credential names. Values are never logged, hashed into a
 * receipt or returned; the child inherits them from the operator's secret
 * injection and the spec asserts their shape itself. */
export function hasCommunityCreationCredentials(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const email = env.E2E_PRIVY_EMAIL?.trim() || env.MODERATION_E2E_OWNER_EMAIL?.trim();
  const otp = env.E2E_PRIVY_OTP?.trim() || env.MODERATION_E2E_OWNER_OTP?.trim();
  return Boolean(email && otp && /^\d{6}$/u.test(otp));
}

export type CommunityCreationCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
}>;

export type CommunityCreationCommand = (input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}) => Promise<CommunityCreationCommandResult>;

/** Runs the required creation journey in the sibling Solid checkout. A
 * non-zero exit returns an unresolved result rather than throwing, so the
 * caller owns the refusal and no child output escapes through an error. */
export const runCommunityCreationCommand: CommunityCreationCommand = async (input) => {
  try {
    const result = await execute("bun", ["run", "test:e2e:community-creation"], {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: { ...input.env },
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

/** Durable, redacted acceptance evidence. It records that the journey ran and
 * the digest of its output, never the output or any credential. */
export async function writeCommunityCreationEvidence(
  markerDirectory: string,
  evidence: CommunityCreationEvidence,
): Promise<void> {
  const record = {
    schema_version: 1,
    surface: "community-creation-e2e",
    result: "passed",
    target: evidence.target,
    output_sha256: evidence.outputSha256,
    recorded_at: evidence.recordedAt,
  };
  await mkdir(markerDirectory, { recursive: true });
  const path = join(markerDirectory, "staging-community-creation-acceptance.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** The pre-producer product acceptance for the disposable release: run the
 * reviewed community-creation journey through the real UI against the staging
 * origin and require a passing exit. Credentials must be present before the
 * reset can mutate anything, and a failed or timed-out journey refuses the
 * producer release. */
export function makeCommunityCreationAcceptance(input: {
  /** Resolved when the acceptance is constructed, not when it runs, so a
   * missing checkout refuses before any mutation. A thunk keeps test doubles
   * from resolving the real workspace layout. */
  readonly solidRoot: string | (() => string);
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommunityCreationCommand;
  readonly now?: () => string;
  readonly recordEvidence?: (evidence: CommunityCreationEvidence) => Promise<void>;
}) {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000)
    throw new Error("staging_community_creation_timeout_invalid");
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]*$/u.test(input.baseUrl))
    throw new Error("staging_community_creation_target_invalid");
  const solidRoot = typeof input.solidRoot === "function" ? input.solidRoot() : input.solidRoot;
  if (!solidRoot) throw new Error("staging_community_creation_checkout_missing");
  const env = input.env ?? process.env;
  if (!hasCommunityCreationCredentials(env))
    throw new Error("staging_community_creation_credentials_missing");
  const run = input.run ?? runCommunityCreationCommand;
  const now = input.now ?? (() => new Date().toISOString());
  return async (): Promise<void> => {
    const result = await run({
      cwd: solidRoot,
      env: {
        ...env,
        E2E_ALLOW_MUTATION: "1",
        E2E_BASE_URL: input.baseUrl,
      },
      timeoutMs: input.timeoutMs,
    });
    const outputSha256 = createHash("sha256")
      .update(result.stdout)
      .update("\n")
      .update(result.stderr)
      .digest("hex");
    if (!result.ok) throw new Error("staging_community_creation_failed");
    await input.recordEvidence?.({
      target: input.baseUrl,
      outputSha256,
      recordedAt: now(),
    });
  };
}
