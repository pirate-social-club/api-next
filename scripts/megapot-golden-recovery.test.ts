import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { runMultiGolden } from "./megapot-base-sepolia-golden-multi.ts";
import { withGoldenJournal } from "./megapot-golden-journal.ts";
import {
  rehearsalInput,
  rehearsalObservation,
  rehearsalTime,
} from "./megapot-golden-multi.fixture.ts";
import { recoverGoldenDrawing } from "./megapot-golden-readonly.ts";

for (const drawingId of [null, "101"]) {
  test(`hard death preserves lock; operator recovery reconciles ${drawingId ?? "lost drawing"} without writes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "golden-hard-death-"));
    const path = join(directory, "run.jsonl");
    const input = rehearsalInput();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { withGoldenJournal } from ${JSON.stringify(new URL("./megapot-golden-journal.ts", import.meta.url).pathname)};
      await withGoldenJournal(${JSON.stringify(path)}, ${JSON.stringify(input)}, async journal => {
        await journal.save({ ...journal.state, leg_id: "leg", funding_effect_id: "funding", drawing_id: ${JSON.stringify(drawingId)},
          completed_activities: ${JSON.stringify(drawingId ? input.participants.flatMap((p) => p.activities.map((a) => `${p.key}:${a}`)) : [])} });
        console.log("ready");
        await Bun.sleep(60000);
      });
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      // A running owner is never displaced.
      await expect(withGoldenJournal(path, input, async () => {})).rejects.toThrow("EEXIST");
      child.kill("SIGKILL");
      await child.exited;
      expect(JSON.parse(await readFile(`${path}.lock`, "utf8")).pid).toBe(child.pid);
      await expect(withGoldenJournal(path, input, async () => {})).rejects.toThrow("EEXIST");
      const before = await readFile(path, "utf8");
      // Mirrors the documented operator-only archival step AFTER confirmed process exit.
      await rename(`${path}.lock`, `${path}.lock.recovered`);
      let discoveries = 0;
      const forbidden = async (): Promise<never> => {
        throw new Error("Unexpected mutation/provider/preflight call");
      };
      const deps: NonNullable<Parameters<typeof runMultiGolden>[2]> = {
        adopt: async () => {},
        now: () => rehearsalTime + 30 * 60000,
        sleep: forbidden,
        readArtifact: forbidden,
        readAudio: forbidden,
        verifyIdentity: forbidden,
        pool: forbidden,
        activity: forbidden,
        read: async (_url, _host, _db, fn) => fn(new Client()),
        recoverDrawing: async (_client, actualInput, leg) => {
          discoveries++;
          expect(leg).toBe("leg");
          expect(actualInput).toEqual(input);
          return "101";
        },
        observe: async (_client, leg, drawing) => {
          expect([leg, drawing]).toEqual(["leg", "101"]);
          expect(
            JSON.parse((await readFile(path, "utf8")).trim().split("\n").at(-1) ?? "").drawing_id,
          ).toBe("101");
          return {
            ...rehearsalObservation(),
            observed_at: new Date(rehearsalTime + 30 * 60000).toISOString(),
          };
        },
      };
      const options = {
        execute: true,
        reconcileOnly: true,
        journalPath: path,
        environment: {
          API_NEXT_ENV: "staging",
          CONTROL_PLANE_POSTGRES_RUNTIME_URL: "unused",
          PIRATE_STAGING_POSTGRES_HOST: "unused",
          PIRATE_STAGING_POSTGRES_DATABASE: "unused",
        },
      };
      for (let replay = 0; replay < 2; replay++) {
        expect(await runMultiGolden(input, options, deps)).toMatchObject({
          state: drawingId ? "reconciled_no_win" : "activity_evidence_incomplete",
          terminal: drawingId !== null,
        });
      }
      await expect(
        runMultiGolden(input, { ...options, reconcileOnly: false }, deps),
      ).rejects.toThrow("Outside authorized run window");
      expect(discoveries).toBe(drawingId ? 0 : 1);
      expect((await readFile(path, "utf8")).startsWith(before)).toBe(true);
      expect(JSON.parse(await readFile(`${path}.lock.recovered`, "utf8")).pid).toBe(child.pid);
    } finally {
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}

test("drawing discovery fails closed for missing or multiple historical drawings", async () => {
  for (const rows of [[], [{ drawing_id: "101" }, { drawing_id: "102" }]]) {
    const client = new Client();
    Object.assign(client, { query: async () => ({ rows }) });
    await expect(recoverGoldenDrawing(client, rehearsalInput(), "leg")).rejects.toThrow(
      "missing or ambiguous",
    );
  }
});

test("drawing recovery binds the exact journal leg and song", async () => {
  const input = rehearsalInput();
  const client = new Client();
  Object.assign(client, {
    query: async (_sql: string, values: unknown[]) => {
      expect(values).toEqual(["leg", input.community_id, input.post_id, input.audio_revision]);
      return { rows: [{ drawing_id: "101" }] };
    },
  });
  expect(await recoverGoldenDrawing(client, input, "leg")).toBe("101");
});
