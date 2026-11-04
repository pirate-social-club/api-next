// Adapted from the accepted serving-form rehearsal in rewards-conditioned-retries.
// The caller verifies the isolated plan and consumes each mutation once.
import { fixturePersonas } from "./run-evidence.mjs";
import { isolatedOrigins } from "./worker-plan.mjs";

function assertIsolated(page) {
  if (new URL(page.url()).origin !== isolatedOrigins.web)
    throw new Error("Rewards browser origin differs");
}
export async function typeBoostAmount(dialog, label, value) {
  const field = dialog.getByRole("textbox", { name: label, exact: true });
  await field.click();
  await field.press("Control+a");
  await field.press("Backspace");
  await field.pressSequentially(value, { delay: 80 });
  await field.press("Tab");
  if ((await field.inputValue()) !== value) throw Error("Boost field value differs");
}

export async function reviewBoost(page, { communityPath, postId, personaId, endsAt }) {
  assertIsolated(page);
  if (new URL(communityPath, isolatedOrigins.web).origin !== isolatedOrigins.web)
    throw new Error("Community origin differs");
  const response = await page.goto(communityPath, {
    waitUntil: "domcontentloaded",
  });
  if (response?.status() !== 200) throw Error("Community page read refused");
  await page.locator("#app-root[data-hydrated='true']").waitFor({ state: "attached" });
  // Hydration can precede the signed-in shell's replacement of its public feed.
  // Wait for the real session projection and settled reads before opening a menu.
  await page.getByRole("button", { name: /^Switch profile, currently / }).waitFor();
  await page.waitForLoadState("networkidle");
  const card = page.locator(`[data-community-post="${postId}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "Song actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Boost", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Create a bounty",
    exact: true,
  });
  const persona = dialog.getByRole("combobox", {
    name: "Persona",
    exact: true,
  });
  await persona.waitFor();
  if ((await persona.inputValue()) !== personaId) throw Error("Sponsor persona differs");
  await dialog.getByRole("radio", { name: /^Megapot ticket/ }).check();
  await dialog.getByRole("radio", { name: "Either", exact: true }).check();
  await typeBoostAmount(dialog, "Total budget (USDC)", "1");
  const disclosure = dialog
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "More options" }) });
  if ((await disclosure.getAttribute("open")) === null) await disclosure.locator("summary").click();
  await typeBoostAmount(dialog, "Maximum ticket price (USDC)", "0.05");
  await typeBoostAmount(dialog, "Additional score floor (%)", "70");
  await typeBoostAmount(dialog, "Entry cutoff before drawing (seconds)", "300");
  const endTime = Date.parse(endsAt);
  if (!Number.isFinite(endTime) || endTime % 60000 !== 0 || endTime <= Date.now())
    throw Error("Exact offer end must have minute precision");
  const local = await page.evaluate(
    (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16),
    endTime,
  );
  const end = dialog.getByLabel("Offer ends (your local time)", {
    exact: true,
  });
  if ((await end.getAttribute("type")) !== "datetime-local") throw Error("Offer end input differs");
  await end.fill(local);
  await dialog.getByRole("button", { name: "Review terms", exact: true }).click();
  await dialog.getByRole("button", { name: "Create reward", exact: true }).waitFor();
  const text = await dialog.innerText();
  for (const expected of [
    "1 USDC",
    "70%",
    "0.05 USDC",
    "300 seconds",
    "Study: 70% correct",
    "Singing: 70% score, 85% coverage and at least 5 scored lines",
  ])
    if (!text.includes(expected)) throw Error(`Reviewed Boost terms missing ${expected}`);
  return {
    dialog,
    endsAt: new Date(endTime).toISOString(),
    renderedTerms: text,
  };
}

export async function createReviewedBoost(dialog, beforeCreate) {
  if (typeof beforeCreate !== "function") throw Error("Creation prerequisite callback required");
  const create = dialog.getByRole("button", {
    name: "Create reward",
    exact: true,
  });
  await create.waitFor();
  // The caller verifies prerequisites, then consumes exactly once here.
  await beforeCreate();
  await create.click();
}

export async function enterKaraoke(page, beforeStart) {
  assertIsolated(page);
  if (typeof beforeStart !== "function") throw Error("Karaoke prerequisite callback required");
  const start = page.getByRole("button", {
    name: "Start karaoke",
    exact: true,
  });
  await start.waitFor();
  await page.waitForLoadState("networkidle");
  await beforeStart();
  await start.click();
  await page.getByRole("dialog").waitFor();
  const choice = page.getByRole("dialog", { name: /^(Singing as|Set up singing)$/ });
  if (await choice.isVisible()) {
    const input = choice.locator(`input[type="radio"][value="${fixturePersonas.karaoke}"]`);
    if ((await input.count()) !== 1) throw Error("Existing Karaoke fixture persona missing");
    const id = await input.getAttribute("id");
    if (!/^[a-zA-Z0-9_:-]{1,200}$/.test(id ?? ""))
      throw Error("Karaoke persona option identity missing");
    await choice.locator(`label[for="${id}"]`).click();
  }
  const disclosure = page.getByRole("dialog", {
    name: "Recording disclosure",
    exact: true,
  });
  await disclosure.waitFor();
  await disclosure.getByRole("button", { name: "Continue to record", exact: true }).click();
}
