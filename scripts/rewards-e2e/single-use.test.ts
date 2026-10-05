import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOnce } from "./single-use.mjs";

function directory() {
  return mkdtempSync(join(tmpdir(), "rewards-once-"));
}
test("failed funding, participant or final brake check consumes nothing", async () => {
  for (const phase of ["funding", "participant", "brake"]) {
    const path = directory();
    let sends = 0;
    try {
      await expect(
        executeOnce(
          path,
          "study",
          async () => {
            if (phase !== "brake") throw new Error(phase);
          },
          async () => {
            sends++;
          },
          {
            deadline: Date.now() + 10000,
            recheck: async () => {
              if (phase === "brake") throw new Error(phase);
            },
          },
        ),
      ).rejects.toThrow(phase);
      expect(sends).toBe(0);
      expect(readdirSync(path)).toEqual([]);
    } finally {
      rmSync(path, { recursive: true });
    }
  }
});
test("a deadline arriving during prerequisite reads leaves no marker", async () => {
  const path = directory();
  let time = 0,
    sends = 0;
  try {
    await expect(
      executeOnce(
        path,
        "fund",
        async () => {
          time = 100;
        },
        async () => {
          sends++;
        },
        { deadline: 100, now: () => time, recheck: async () => {} },
      ),
    ).rejects.toThrow("deadline");
    expect(sends).toBe(0);
    expect(readdirSync(path)).toEqual([]);
  } finally {
    rmSync(path, { recursive: true });
  }
});
test("an uncertain click remains consumed and cannot launch twice", async () => {
  const path = directory();
  let sends = 0;
  const send = async () => {
    sends++;
    throw new Error("uncertain provider result");
  };
  const options = { deadline: Date.now() + 10000, recheck: async () => {} };
  try {
    await expect(executeOnce(path, "fund", async () => {}, send, options)).rejects.toThrow(
      "uncertain",
    );
    await expect(executeOnce(path, "fund", async () => {}, send, options)).rejects.toThrow(
      "already consumed",
    );
    expect(sends).toBe(1);
  } finally {
    rmSync(path, { recursive: true });
  }
});
test("competing commands can submit only one action", async () => {
  const path = directory();
  let sends = 0;
  try {
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        executeOnce(
          path,
          "create-offer",
          async () => {},
          async () => {
            sends++;
          },
          { deadline: Date.now() + 10000, recheck: async () => {} },
        ),
      ),
    );
    expect(sends).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  } finally {
    rmSync(path, { recursive: true });
  }
});
