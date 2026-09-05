import { mkdir, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireContinuityEvidence, verifyAuthorityProof } from "./hns-continuity/acquire.mjs";
import { buildContinuityCandidate } from "./hns-continuity/candidate.mjs";
import { openContinuityDatabase, readContinuityState } from "./hns-continuity/database.mjs";
import { promoteContinuity } from "./hns-continuity/promotion.mjs";
import { ContinuityRefusal, continuityFailureMessage } from "./hns-continuity/refusal.mjs";

const usage =
  "hns-continuity.ts observe --root ROOT --ssh-host USER@HOST --directory ABSOLUTE_PATH | dry-run|rehearse|commit --directory ABSOLUTE_PATH --confirm-sha256 SHA256";

async function readBounded(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(8 * 1024 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead === buffer.length)
      throw new ContinuityRefusal("Observation file size invalid");
    return buffer.slice(0, bytesRead);
  } finally {
    await file.close();
  }
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(path)));

export function parseContinuityArguments(args: readonly string[]) {
  const mode = args[0];
  if (mode !== "observe" && mode !== "dry-run" && mode !== "rehearse" && mode !== "commit")
    throw new ContinuityRefusal(usage);
  const values = new Map<string, string>();
  const allowed =
    mode === "observe"
      ? ["--directory", "--root", "--ssh-host"]
      : ["--directory", "--confirm-sha256"];
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !allowed.includes(flag) || values.has(flag))
      throw new ContinuityRefusal(usage);
    values.set(flag, value);
  }
  const directory = values.get("--directory");
  if (directory === undefined || !isAbsolute(directory) || directory.includes("\0"))
    throw new ContinuityRefusal(usage);
  if (mode === "observe") {
    const root = values.get("--root");
    const sshHost = values.get("--ssh-host");
    if (
      root === undefined ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(root) ||
      sshHost === undefined ||
      !/^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/u.test(sshHost)
    )
      throw new ContinuityRefusal(usage);
    return { mode, directory, root, sshHost } as const;
  }
  const confirmedSha256 = values.get("--confirm-sha256");
  if (confirmedSha256 === undefined || !/^[0-9a-f]{64}$/u.test(confirmedSha256))
    throw new ContinuityRefusal(usage);
  return { mode, directory, confirmedSha256 } as const;
}

async function sourceCommit(): Promise<string> {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd });
  if (status.exitCode !== 0 || status.stdout.length !== 0 || head.exitCode !== 0)
    throw new ContinuityRefusal("Use a clean reviewed source checkout for the ceremony");
  return head.stdout.toString().trim();
}

export async function main(args = Bun.argv.slice(2)) {
  const options = parseContinuityArguments(args);
  const connection = process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL;
  if (connection === undefined)
    throw new ContinuityRefusal("CONTROL_PLANE_POSTGRES_ADMIN_URL is required");
  const currentSource = await sourceCommit();
  const { directory } = options;
  const client = openContinuityDatabase(connection);
  await client.connect();
  try {
    if (options.mode === "observe") {
      await mkdir(directory, { mode: 0o700 });
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let state: Awaited<ReturnType<typeof readContinuityState>>;
      try {
        await client.query("SET LOCAL search_path TO api_next, public");
        await client.query("SET LOCAL statement_timeout TO '10s'");
        state = await readContinuityState(client, options.root);
      } finally {
        await client.query("ROLLBACK");
      }
      await Bun.write(`${directory}/state.json`, JSON.stringify(state));
      await Bun.write(`${directory}/source.json`, JSON.stringify(currentSource));
      await acquireContinuityEvidence({ directory, state, sshHost: options.sshHost });
    }
    await verifyAuthorityProof(directory, true);
    const [state, chain, primary, secondary, verification, capturedSource] = await Promise.all(
      ["state", "chain", "zone-primary", "zone-secondary", "authority-verification", "source"].map(
        (name) => readJson(`${directory}/${name}.json`),
      ),
    );
    if (capturedSource !== currentSource)
      throw new ContinuityRefusal("Observation source differs from the current reviewed checkout");
    const prepared = await buildContinuityCandidate({
      state,
      chain,
      primary,
      secondary,
      verification,
      sourceCommit: currentSource,
    });
    if (options.mode === "observe") {
      await Bun.write(`${directory}/candidate.json`, prepared.candidate_bytes);
      return {
        mode: options.mode,
        candidate_sha256: prepared.candidate_sha256,
        generations: prepared.candidate.generations,
      };
    }
    const receipt = await promoteContinuity({
      client,
      state,
      prepared,
      reviewedCandidateBytes: await readBounded(`${directory}/candidate.json`),
      expectedCandidateSha256: options.confirmedSha256,
      mode:
        options.mode === "dry-run"
          ? "--preflight"
          : options.mode === "rehearse"
            ? "--rehearse"
            : "--commit",
    });
    await Bun.write(
      `${directory}/receipt-${options.mode}-${Date.now()}.json`,
      JSON.stringify(receipt),
    );
    return receipt;
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  await main()
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      console.error(
        `${continuityFailureMessage(error)}. If commit was attempted, reconcile database generations before retrying.`,
      );
      process.exitCode = 1;
    });
}
