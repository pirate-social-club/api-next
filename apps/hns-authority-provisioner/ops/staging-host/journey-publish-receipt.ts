import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export const JOURNEY_ROOT = /^e2e[a-z0-9]{6,40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
export const JOURNEY_LEASE_DIRECTORY =
  process.env.HNS_JOURNEY_LEASE_DIR ?? "/var/tmp/pirate-hns-staging-journey";

export class JourneyRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
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

const publishAttemptPath = (root: string, directory = JOURNEY_LEASE_DIRECTORY) =>
  join(directory, `publish-${root}.json`);

/** This file is the dispatch fence, not proof that the RPC succeeded. A
 * partial write still occupies the name and must be reconciled manually. */
export async function claimPublishAttempt(
  attempt: Omit<PublishAttempt, "status" | "txid" | "inclusion_height">,
  directory = JOURNEY_LEASE_DIRECTORY,
) {
  if (
    !JOURNEY_ROOT.test(attempt.root) ||
    !SHA256.test(attempt.publish_plan_sha256) ||
    !SHA256.test(attempt.encoded_resource_sha256) ||
    !SHA256.test(attempt.response_sha256) ||
    attempt.root_import_session_id.length === 0
  )
    throw new JourneyRefusal("publish_claim_invalid");
  const path = publishAttemptPath(attempt.root, directory);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new JourneyRefusal("publish_attempt_exists");
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ ...attempt, status: "dispatch_claimed" }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return path;
}

/** Replace only the matching claim. A failed finalization leaves the claim in
 * place and never authorizes another sendupdate. */
export async function finalizePublishAttempt(
  attempt: Omit<PublishAttempt, "status" | "txid" | "inclusion_height">,
  result: Pick<PublishAttempt, "status" | "txid" | "inclusion_height">,
  directory = JOURNEY_LEASE_DIRECTORY,
) {
  if (
    (result.status !== "broadcasted" && result.status !== "included") ||
    typeof result.txid !== "string" ||
    !SHA256.test(result.txid) ||
    (result.status === "included" &&
      (!Number.isSafeInteger(result.inclusion_height) || (result.inclusion_height ?? 0) < 1))
  )
    throw new JourneyRefusal("publish_result_invalid");
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
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
