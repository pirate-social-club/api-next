/**
 * Builds the HNS owner verifier exactly as it exists at a git ref into one
 * module, so a mixed-version test can run the current HTTP Worker against the
 * previous verifier build rather than a stub of it.
 *
 * Usage: bun scripts/hns-previous-verifier-bundle.ts --ref <git-ref> --out <file.js>
 *
 * The ref's own tree supplies every workspace package, installed from its own
 * lockfile, so nothing from the current checkout enters the build. The script
 * prints the resolved commit and the bundle digest for the record.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing ${name}. Usage: --ref <git-ref> --out <file.js>`);
  }
  return value;
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

export async function buildPreviousVerifierBundle(ref: string, out: string): Promise<string> {
  const commit = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], repositoryRoot).trim();
  const tree = await mkdtemp(join(tmpdir(), "hns-previous-verifier-"));
  try {
    const archive = spawnSync("git", ["archive", "--format=tar", commit], {
      cwd: repositoryRoot,
      maxBuffer: 1 << 30,
    });
    if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
    const extract = spawnSync("tar", ["-x", "-C", tree], { input: archive.stdout });
    if (extract.status !== 0) throw new Error(`tar failed: ${extract.stderr}`);
    run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], tree);
    const target = resolve(out);
    run(
      "bun",
      [
        "build",
        "apps/hns-owner-verifier/src/index.ts",
        "--target=bun",
        "--tsconfig-override",
        join(tree, "tsconfig.json"),
        "--outfile",
        target,
      ],
      tree,
    );
    const digest = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    return `${commit} ${digest}`;
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  console.log(await buildPreviousVerifierBundle(option(args, "--ref"), option(args, "--out")));
}
