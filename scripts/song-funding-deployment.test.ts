import { expect, test } from "bun:test";
import { type CommandRunner, deployWorkerWithProvenance } from "./deploy-worker-with-provenance.ts";
import { makeSongFundingAdmissionFixture } from "./song-funding-binding-admission.fixture.ts";

test("the complete deployment wrapper refuses a newly served version that lost or replaced its admitted funding binding", async () => {
  for (const fault of ["none", "missing", "id", "lane"] as const) {
    const f = makeSongFundingAdmissionFixture("jobs"),
      commands: (readonly string[])[] = [];
    const source = "a".repeat(40),
      configPath = "apps/jobs-worker/wrangler.jsonc";
    const answers = [
      source,
      "",
      "",
      "",
      configPath,
      "[]",
      "uploaded",
      JSON.stringify([{ id: "new", annotations: { "workers/message": `git:${source}` } }]),
    ];
    const runner: CommandRunner = async (command) => {
      commands.push([...command]);
      if (command[0] === "bunx" && command.includes("deploy")) {
        f.deploy();
        f.deployed(
          f.candidate.bindings.flatMap((b) => {
            if (fault === "missing" && b.name === "SONG_FUNDING_JOBS") return [];
            if (fault === "id" && b.name === "SONG_FUNDING_JOBS")
              return [{ ...b, id: "unreviewed" }];
            if (fault === "lane" && b.name === "SAFE_POOL_PILOT_ENABLED")
              return [{ ...b, text: "false" }];
            return [b];
          }),
        );
      }
      const stdout = answers.shift();
      if (stdout === undefined) throw Error("Unexpected deployment command");
      return { exitCode: 0, stdout, stderr: "" };
    };
    const outcome = deployWorkerWithProvenance(
      "/repo",
      {
        configPath,
        environment: "production",
        sourceRef: "origin/main",
        acceptedMainRef: "origin/main",
      },
      runner,
      () => {},
      undefined,
      async (_root, _config, _env, operation) => operation(),
      async () => null,
      async (_root, _config, _env, operation) => operation(),
      async (_root, _config, operation) => operation(),
      async () => f.run(),
    );
    if (fault === "none") expect((await outcome).worker_version_id).toBe("new");
    else
      await expect(outcome).rejects.toThrow("New funding Worker bindings or lane posture differ");
    // A failed post-upload readback never repeats a potentially applied upload.
    expect(commands.filter((c) => c[0] === "bunx" && c.includes("deploy"))).toHaveLength(1);
    expect(answers).toHaveLength(0);
  }
});
