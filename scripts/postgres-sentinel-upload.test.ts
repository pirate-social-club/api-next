import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
};
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text(),
) as { jobs: Record<string, { steps: Step[] }> };
const general = workflow.jobs["postgres17-general"]?.steps ?? [];
const aggregate = workflow.jobs.postgres17?.steps ?? [];
const detector = general.find((step) => step.id === "song-video-sentinels");
const suites = ["composed-flow", "render-host"] as const;

describe("shard-independent song-video sentinel uploads", () => {
  test("requires unique immutable artifacts and refuses missing dedicated uploads", () => {
    expect(detector?.if).toBeUndefined();
    expect(detector?.env?.SENTINEL_DIRECTORY).toBe("/tmp");
    expect(detector?.env?.SHARD_INDEX).toBe("${{ matrix.shard }}");
    for (const suite of suites) {
      const name = `postgres17-sentinels-song-video-${suite}`;
      const uploads = general.filter((step) => step.with?.name === name);
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.if).toBe(
        `steps.song-video-sentinels.outputs.${suite.replaceAll("-", "_")} == 'true'`,
      );
      expect(uploads[0]?.with?.overwrite).toBe(false);
      expect(uploads[0]?.with?.["if-no-files-found"]).toBe("error");
      expect(uploads[0]?.with?.path).toBe(
        `/tmp/api-next-control-plane-postgres-song-video-${suite}-suite-complete`,
      );
      const downloads = aggregate.filter((step) => step.with?.name === name);
      expect(downloads).toHaveLength(1);
      expect(downloads[0]?.if).toBeUndefined();
      expect(downloads[0]?.uses).toStartWith("actions/download-artifact@");
    }
  });

  for (const shard of [0, 1, 2, 3]) {
    for (const present of [[], [suites[0]], [suites[1]], [...suites]]) {
      test(`detects only produced markers on shard ${shard}: ${present.join(",") || "none"}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "postgres-sentinel-upload-"));
        try {
          const output = join(directory, "outputs");
          await writeFile(output, "");
          for (const suite of present) {
            const marker = `api-next-control-plane-postgres-song-video-${suite}-suite-complete`;
            await writeFile(join(directory, marker), `${marker}\n`);
          }
          const result = Bun.spawnSync(["bash", "-c", detector?.run ?? "exit 99"], {
            env: {
              ...process.env,
              SENTINEL_DIRECTORY: directory,
              SHARD_INDEX: String(shard),
              GITHUB_OUTPUT: output,
            },
          });
          expect(result.exitCode).toBe(0);
          expect(await readFile(output, "utf8")).toBe(
            present.map((suite) => `${suite.replaceAll("-", "_")}=true\n`).join(""),
          );
          for (const suite of present) {
            expect(result.stdout.toString()).toContain(
              `song-video ${suite} sentinel: shard ${shard}`,
            );
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }

  test("refuses a malformed marker before authorizing its upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "postgres-sentinel-upload-"));
    try {
      const output = join(directory, "outputs");
      await writeFile(output, "");
      await writeFile(
        join(directory, "api-next-control-plane-postgres-song-video-render-host-suite-complete"),
        "wrong marker\n",
      );
      const result = Bun.spawnSync(["bash", "-c", detector?.run ?? "exit 99"], {
        env: {
          ...process.env,
          SENTINEL_DIRECTORY: directory,
          SHARD_INDEX: "2",
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(output, "utf8")).toBe("");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
