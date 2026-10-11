import { isolatedOrigins } from "./worker-plan.mjs";

// The Study actor also sponsors, as in the previously approved Study window.
// Its existing test balance avoids an extra wallet provisioning transfer.
export const fixtureAccounts = Object.freeze({
  sponsor: {
    accountId: "usr_87b732b0-6ab4-45fe-a91b-9b4c9f54e15e",
    credentialPrefix: "MODERATION_E2E_MEMBER",
  },
  study: {
    accountId: "usr_87b732b0-6ab4-45fe-a91b-9b4c9f54e15e",
    credentialPrefix: "MODERATION_E2E_MEMBER",
  },
  karaoke: {
    accountId: "usr_00577b1e-2aba-46ca-aea3-3cb4cf4004aa",
    credentialPrefix: "MODERATION_E2E_M1",
  },
});

function failure(phase, status) {
  return Object.assign(
    new Error("Isolated account authentication refused; credentials suppressed"),
    {
      stage: "account-authentication",
      phase,
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    },
  );
}

function assertOrigin(page) {
  if (new URL(page.url()).origin !== isolatedOrigins.web) throw failure("wrong-origin");
}

/** Browser-owned reads preserve the HttpOnly session; cookies never leave the context. */
export async function readBrowserAccount(page) {
  assertOrigin(page);
  try {
    return await page.evaluate(async () => {
      const response = await fetch("/api/users/me", { signal: AbortSignal.timeout(8_000) });
      return {
        status: response.status,
        accountId: response.status === 200 ? (await response.json()).id : undefined,
      };
    });
  } catch {
    throw failure("account-read-failed");
  }
}

/** Repeat only reads while the one ordinary UI submission completes. */
export async function waitForBrowserAccount(read, expectedAccountId, options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((accept) => setTimeout(accept, ms)));
  const deadline = now() + 30_000;
  while (now() < deadline) {
    let observed;
    try {
      observed = await read();
    } catch {
      throw failure("account-read-failed");
    }
    if (now() >= deadline) throw failure("completion-timeout", observed.status);
    if (observed.failed) throw failure("form-refused", observed.status);
    if (observed.status === 200 && observed.accountId !== expectedAccountId)
      throw failure("wrong-account", observed.status);
    if (![200, 401].includes(observed.status))
      throw failure("account-read-refused", observed.status);
    if (observed.status === 200 && observed.complete)
      return { accountId: expectedAccountId, verified: true };
    await sleep(Math.min(500, deadline - now()));
  }
  throw failure("completion-timeout");
}

/** Fresh contexts must perform their own real app sign-in before any funded step. */
export async function signInFixture(page, role, credentials = process.env) {
  const fixture = fixtureAccounts[role];
  if (!fixture) throw failure("invalid-role");
  const email = credentials[`${fixture.credentialPrefix}_EMAIL`];
  const code = credentials[`${fixture.credentialPrefix}_OTP`];
  if (typeof email !== "string" || !email.includes("@") || !/^[0-9]{6}$/.test(code ?? ""))
    throw failure("credentials-unavailable");
  assertOrigin(page);
  const initial = await readBrowserAccount(page);
  if (initial.status !== 401) throw failure("fresh-session-required", initial.status);
  try {
    const emailField = page.getByRole("textbox", { name: "Email", exact: true });
    if (!(await emailField.isVisible()))
      await page.getByRole("button", { name: /^sign in$/i }).click();
    await emailField.waitFor({ state: "visible", timeout: 10_000 });
    assertOrigin(page);
    await emailField.fill(email);
    await page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await page
      .locator('[aria-label="Verification code digit 1 of 6"]')
      .waitFor({ state: "visible" });
    assertOrigin(page);
    for (let index = 0; index < 6; index++)
      await page
        .locator(`[aria-label="Verification code digit ${index + 1} of 6"]`)
        .fill(code[index]);
    await page.getByRole("button", { name: "Verify and continue", exact: true }).click();
  } catch {
    throw failure("form-step-failed");
  }
  return waitForBrowserAccount(async () => {
    const account = await readBrowserAccount(page);
    return {
      ...account,
      failed: await page.locator("[data-auth-panel] [role=alert]").isVisible(),
      complete:
        (await page.locator("[data-auth-panel]").count()) === 0 ||
        (await page.getByText("You’re signed in.", { exact: true }).isVisible()),
    };
  }, fixture.accountId);
}
