import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { STAGING_RESET_RELEASE } from "./staging-persona-reset-plan.ts";

/** Assert the supplied working directory; never search parents or select a
 * different checkout. Immutable reset artifacts still undergo their complete
 * pinned manifest/checksum validation when the grant vocabulary is compiled. */
export function assertKaraokeRepositoryRoot(directory = process.cwd()): string {
  try {
    const root = realpathSync(directory);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== root)
      throw new Error("not repository root");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== "api-next" || manifest.private !== true) throw new Error("not api-next");
    git(["cat-file", "-e", `${STAGING_RESET_RELEASE.sourceSha}^{commit}`]);
    return root;
  } catch {
    // Git/JSON errors can disclose local paths; expose only the refusal stage.
    throw new Error("karaoke_release_repository_root_denied");
  }
}
