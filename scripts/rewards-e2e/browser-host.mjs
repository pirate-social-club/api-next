import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { fixtureAccounts, signInFixture } from "./browser-accounts.mjs";
import { isolatedOrigins } from "./worker-plan.mjs";

export async function closeOwnedBrowsers(browsers, report, save) {
  const outcomes = await Promise.allSettled(browsers.map((browser) => browser.close()));
  report.browsersClosed = outcomes.every((outcome) => outcome.status === "fulfilled");
  report.closedAt = new Date().toISOString();
  save();
  if (!report.browsersClosed) throw Error("Owned browser cleanup incomplete");
}

/** The caller verifies deployed source and resource scope before this host owns sessions. */
export async function prepareFixtureBrowsers(directory, audioPaths, verifyPreparation) {
  if (typeof verifyPreparation !== "function")
    throw new Error("Browser preparation verifier required");
  await verifyPreparation();
  const audio = {};
  for (const role of Object.keys(fixtureAccounts)) {
    const path = resolve(audioPaths[role]);
    const bytes = readFileSync(path);
    if (
      bytes.length < 44 ||
      bytes.length > 256_000_000 ||
      bytes.subarray(0, 4).toString() !== "RIFF" ||
      bytes.subarray(8, 12).toString() !== "WAVE"
    )
      throw new Error("Fixture microphone must be a bounded WAV file");
    audio[role] = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    if (
      role === "karaoke" &&
      audio[role].sha256 !== "1b229646580d7121064d75b3c17bc1c623dc253cb8b510a2ef919c3d22901208"
    )
      throw new Error("Accepted Karaoke microphone fixture differs");
  }
  const marker = resolve(directory, "browser-host.json");
  const ownership = openSync(marker, "wx", 0o600);
  closeSync(ownership);
  const report = { status: "preparing", startedAt: new Date().toISOString(), accounts: [] };
  const save = () => writeFileSync(marker, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  save();
  const browsers = [],
    pages = {};
  const close = () => closeOwnedBrowsers(browsers, report, save);
  try {
    for (const [role, fixture] of Object.entries(fixtureAccounts)) {
      const browser = await chromium.launch({
        headless: true,
        args: [
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          `--use-file-for-fake-audio-capture=${audio[role].path}`,
        ],
      });
      browsers.push(browser);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "UTC",
        permissions: ["microphone"],
      });
      const page = await context.newPage();
      const response = await page.goto(isolatedOrigins.web, { waitUntil: "domcontentloaded" });
      if (response?.status() !== 200) throw new Error("Isolated browser document refused");
      await page.locator("#app-root[data-hydrated='true']").waitFor({ state: "attached" });
      await signInFixture(page, role);
      pages[role] = page;
      report.accounts.push({
        role,
        accountId: fixture.accountId,
        verifiedAt: new Date().toISOString(),
        microphoneSha256: audio[role].sha256,
      });
      save();
    }
    report.status = "prepared";
    report.preparedAt = new Date().toISOString();
    save();
    return { pages, report, close };
  } catch (error) {
    report.status = "refused";
    report.failureStage =
      error?.stage === "account-authentication" ? error.phase : "browser-preparation";
    await close();
    throw new Error(
      `Isolated browser preparation refused at ${report.failureStage}; credentials suppressed`,
    );
  }
}
