import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const solidSource = "8baa1948f767cbf8b2876c8cce2ad14255688250";
/** Bundle the published Solid wallet adapter; real Privy is retained, without exporting credentials. */
export async function buildBrowserWalletDriver(solidRoot) {
  const require = createRequire(import.meta.url);
  const esbuild = require(
    require.resolve("esbuild", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
  );
  const sourceRoot = mkdtempSync(join(tmpdir(), "rewards-wallet-source-"));
  try {
    const archive = execFileSync("git", ["archive", solidSource, "src", "package.json"], {
      cwd: solidRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", sourceRoot], { input: archive });
    const dependencies = JSON.parse(
      readFileSync(join(sourceRoot, "package.json"), "utf8"),
    ).dependencies;
    for (const dependency of ["@privy-io/js-sdk-core", "viem"]) {
      const installed = JSON.parse(
        readFileSync(join(solidRoot, "node_modules", dependency, "package.json"), "utf8"),
      );
      if (installed.version !== dependencies[dependency])
        throw Error("Published wallet SDK dependency differs");
    }
    const built = await esbuild.build({
      stdin: {
        contents: `import {createRewardWalletSession}from ${JSON.stringify(join(sourceRoot, "src/api/reward-wallet-session.ts"))};
export async function openWallet(){if(location.origin!=="https://web-megapot-e2e-staging.pirate.sc")throw Error("Isolated wallet origin required");const response=await fetch("/internal/verification/config");if(!response.ok)throw Error("Wallet configuration refused");const config=await response.json();if(config.privyAppId!=="cmsw5pis300b80cladbxx7bsr")throw Error("Wallet app differs");return createRewardWalletSession(config);}`,
        resolveDir: sourceRoot,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "IsolatedRewardsWallet",
      target: "es2022",
      write: false,
      nodePaths: [resolve(solidRoot, "node_modules")],
      minify: false,
      logLevel: "silent",
    });
    const script = built.outputFiles[0].text;
    return { script, solidSource, sha256: createHash("sha256").update(script).digest("hex") };
  } finally {
    rmSync(sourceRoot, { recursive: true });
  }
}

/** Use the page's existing CSP nonce; no security policy or browser option is disabled. */
export async function installBrowserWalletDriver(page, driver) {
  if (new URL(page.url()).origin !== "https://web-megapot-e2e-staging.pirate.sc")
    throw Error("Isolated wallet browser required");
  if (
    createHash("sha256").update(driver.script).digest("hex") !== driver.sha256 ||
    driver.solidSource !== solidSource
  )
    throw Error("Pinned browser wallet artifact differs");
  await page.evaluate((script) => {
    const nonce = document.querySelector("script[nonce]")?.nonce;
    if (!nonce) throw Error("Page CSP nonce unavailable");
    const element = document.createElement("script");
    element.nonce = nonce;
    element.textContent = script;
    document.head.append(element);
    if (typeof IsolatedRewardsWallet?.openWallet !== "function")
      throw Error("Browser wallet artifact refused");
  }, driver.script);
}
