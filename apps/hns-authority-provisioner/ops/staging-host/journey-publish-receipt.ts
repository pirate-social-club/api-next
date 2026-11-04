import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

export const JOURNEY_ROOT = /^e2e[a-z0-9]{6,40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export class JourneyRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * The single-dispatch guard lives in one fixed per-user state directory. It is
 * resolved from the account database, not HOME or any other environment
 * variable, and sits outside aged temporary storage, so neither a caller nor
 * a cleanup timer can redirect or silently remove the fence.
 */
export function journeyStateDirectory(): string {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    throw new JourneyRefusal("state_directory_unresolvable");
  }
  if (!home.startsWith("/")) throw new JourneyRefusal("state_directory_unresolvable");
  return join(home, ".local", "state", "pirate-hns-staging-journey");
}

/**
 * A failure after the dispatch claim. The claim proves only that an attempt
 * was fenced, not that a transaction was broadcast, so this is never a clean
 * refusal. `txid` is present only when the wallet actually returned one.
 */
export class JourneyDispatchAmbiguity extends Error {
  constructor(
    readonly code: string,
    readonly txid: string | null,
    readonly receipt: string,
  ) {
    super(code);
  }
}

/** Refuse unless the directory is a real directory owned by this user with
 * mode 0700. Creation happens only when it is absent. */
export async function requirePrivateStateDirectory(directory = journeyStateDirectory()) {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new JourneyRefusal("state_directory_unreadable");
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const stat = await lstat(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new JourneyRefusal("state_directory_unsafe");
  return directory;
}

type PublishAttempt = Readonly<{
  root: string;
  root_import_session_id: string;
  publish_plan_sha256: string;
  encoded_resource_sha256: string;
  response_sha256: string;
  status: "dispatch_claimed" | "broadcasted" | "included";
  txid?: string;
  inclusion_height?: number;
}>;

const publishAttemptPath = (root: string, directory = journeyStateDirectory()) =>
  join(directory, `publish-${root}.json`);

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** This file is the dispatch fence, not proof that the RPC succeeded. A
 * partial write still occupies the name and must be reconciled manually. */
export async function claimPublishAttempt(
  attempt: Omit<PublishAttempt, "status" | "txid" | "inclusion_height">,
  directory = journeyStateDirectory(),
) {
  if (
    !JOURNEY_ROOT.test(attempt.root) ||
    !SHA256.test(attempt.publish_plan_sha256) ||
    !SHA256.test(attempt.encoded_resource_sha256) ||
    !SHA256.test(attempt.response_sha256) ||
    attempt.root_import_session_id.length === 0
  )
    throw new JourneyRefusal("publish_claim_invalid");
  await requirePrivateStateDirectory(directory);
  const path = publishAttemptPath(attempt.root, directory);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new JourneyRefusal("publish_attempt_exists");
    throw new JourneyRefusal("publish_claim_unwritable");
  }
  try {
    await handle.writeFile(JSON.stringify({ ...attempt, status: "dispatch_claimed" }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
  return path;
}

/** Replace only the matching claim. A failed finalization leaves the claim in
 * place and never authorizes another sendupdate. */
export async function finalizePublishAttempt(
  attempt: Omit<PublishAttempt, "status" | "txid" | "inclusion_height">,
  result: Pick<PublishAttempt, "status" | "txid" | "inclusion_height">,
  directory = journeyStateDirectory(),
) {
  if (
    (result.status !== "broadcasted" && result.status !== "included") ||
    typeof result.txid !== "string" ||
    !SHA256.test(result.txid) ||
    (result.status === "included" &&
      (!Number.isSafeInteger(result.inclusion_height) || (result.inclusion_height ?? 0) < 1))
  )
    throw new JourneyRefusal("publish_result_invalid");
  await requirePrivateStateDirectory(directory);
  const path = publishAttemptPath(attempt.root, directory);
  let previous: PublishAttempt;
  try {
    previous = JSON.parse(await readFile(path, "utf8")) as PublishAttempt;
  } catch {
    throw new JourneyRefusal("publish_claim_unreadable");
  }
  if (
    previous.root !== attempt.root ||
    previous.root_import_session_id !== attempt.root_import_session_id ||
    previous.publish_plan_sha256 !== attempt.publish_plan_sha256 ||
    previous.encoded_resource_sha256 !== attempt.encoded_resource_sha256 ||
    previous.response_sha256 !== attempt.response_sha256 ||
    (previous.status !== "dispatch_claimed" && previous.status !== "broadcasted") ||
    (previous.status === "broadcasted" && previous.txid !== result.txid)
  )
    throw new JourneyRefusal("publish_claim_mismatch");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...attempt, ...result }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await syncDirectory(directory);
}

/** Read-only receipt summary for status and reconciliation. */
export async function readPublishAttempt(root: string, directory = journeyStateDirectory()) {
  const path = publishAttemptPath(root, directory);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "absent" as const, path };
    return { state: "unreadable" as const, path };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PublishAttempt>;
    return {
      state: "present" as const,
      path,
      status: typeof parsed.status === "string" ? parsed.status : null,
      txid: typeof parsed.txid === "string" && SHA256.test(parsed.txid) ? parsed.txid : null,
      inclusion_height:
        typeof parsed.inclusion_height === "number" ? parsed.inclusion_height : null,
      response_sha256:
        typeof parsed.response_sha256 === "string" && SHA256.test(parsed.response_sha256)
          ? parsed.response_sha256
          : null,
    };
  } catch {
    // A torn write still fences the root; report it without guessing.
    return { state: "partial" as const, path };
  }
}

/** The one line a caller may parse on failure: a definite pre-claim refusal,
 * or an ambiguous post-claim dispatch that must be reconciled. */
export function journeyFailureOutput(error: unknown, root: string | null) {
  if (error instanceof JourneyDispatchAmbiguity)
    return {
      exitCode: 3,
      line: {
        outcome: "journey_chain_dispatch_ambiguous",
        code: error.code,
        root,
        txid: error.txid,
        receipt: error.receipt,
      },
    };
  return {
    exitCode: 1,
    line: {
      outcome: "journey_chain_refused",
      code: error instanceof JourneyRefusal ? error.code : "unexpected",
    },
  };
}
