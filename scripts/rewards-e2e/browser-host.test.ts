import { expect, test } from "bun:test";
import { closeOwnedBrowsers } from "./browser-host.mjs";

test("a failed browser close still closes siblings and refuses acceptance", async () => {
  const closed: string[] = [];
  const report: { browsersClosed?: boolean } = {};
  let saved = false;
  await expect(
    closeOwnedBrowsers(
      [
        {
          close: async () => {
            closed.push("first");
            throw Error("Unavailable");
          },
        },
        {
          close: async () => {
            closed.push("second");
          },
        },
      ],
      report,
      () => {
        saved = true;
      },
    ),
  ).rejects.toThrow("cleanup incomplete");
  expect(closed).toEqual(["first", "second"]);
  expect(report.browsersClosed).toBe(false);
  expect(saved).toBe(true);
});
