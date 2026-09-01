import { isAbsolute } from "node:path";
import { buildHnsGenericCaddyCandidate } from "../src/generic-caddy-candidate.ts";

const [sourcePath, candidatePath, rollbackPath] = Bun.argv.slice(2);

if (
  sourcePath === undefined ||
  candidatePath === undefined ||
  rollbackPath === undefined ||
  Bun.argv.length !== 5 ||
  !isAbsolute(sourcePath) ||
  !isAbsolute(candidatePath) ||
  !isAbsolute(rollbackPath) ||
  new Set([sourcePath, candidatePath, rollbackPath]).size !== 3
) {
  throw new Error(
    "usage: build-generic-caddy-candidate <absolute-source> <absolute-candidate> <absolute-rollback>",
  );
}

const source = Bun.file(sourcePath);
if (!(await source.exists()) || source.size === 0 || source.size > 1_048_576) {
  throw new Error("Caddy source is missing or outside the accepted byte bound");
}
if ((await Bun.file(candidatePath).exists()) || (await Bun.file(rollbackPath).exists())) {
  throw new Error("candidate and rollback outputs must not already exist");
}

const built = buildHnsGenericCaddyCandidate(new Uint8Array(await source.arrayBuffer()));
await Bun.write(rollbackPath, built.rollback_bytes);
await Bun.write(candidatePath, built.candidate_bytes);

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

console.log(
  JSON.stringify({
    changed: built.changed,
    https_server: built.https_server,
    general_gateway_spki_sha256: built.general_gateway_spki_sha256,
    source_sha256: await sha256(built.rollback_bytes),
    candidate_sha256: await sha256(built.candidate_bytes),
    source_path: sourcePath,
    candidate_path: candidatePath,
    rollback_path: rollbackPath,
  }),
);
