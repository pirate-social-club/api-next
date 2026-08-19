import { describe, expect, test } from "bun:test";
import * as BunRuntime from "bun";
import { loadConfigFrom, MoneyPathConfig } from "./index.ts";

// Port of the old API's tests/production-money-path-invariant.test.ts
// (read-only source: api/services/api). The incident history that motivates
// it (api#949 rewards armed at testnet USDC; api#999 fail-closed guard
// without its config on a read path; api#1042 unguarded testnet bookings)
// transfers wholesale to api-next.
//
// The invariant: every production money path is EITHER on its mandatory
// mainnet chain, OR on a testnet AND covered by a guard that provably fails
// closed. "Provably" is load-bearing — the test executes the real resolver
// against the real production config and requires it to throw.
//
// api-next has no money paths until M3 (community purchase settlement),
// which is exactly what the ratchet test below enforces: a money path
// cannot appear in the production wrangler config without a declared
// posture here.

const BASE_MAINNET_CHAIN_ID = 8453;
const KNOWN_TESTNET_CHAIN_IDS = new Set([84532]);
const WRANGLER_CONFIG_PATH = new URL("../../../wrangler.jsonc", import.meta.url);

type MoneyPath =
  | {
      chainIdVar: string;
      label: string;
      posture: "mainnet_required";
    }
  | {
      chainIdVar: string;
      label: string;
      posture: "guarded_testnet_exception";
      reason: string;
      // Must THROW when handed the production environment. This is the proof
      // that the testnet posture is inert rather than merely intended to be.
      assertFailsClosed: (env: Record<string, string>) => unknown;
    };

const MONEY_PATHS: MoneyPath[] = [
  {
    chainIdVar: "COMMUNITY_PURCHASE_FUNDING_CHAIN_ID",
    label: "community purchase funding",
    posture: "mainnet_required",
  },
];

const productionVars = await (async (): Promise<Record<string, string>> => {
  const config = BunRuntime.JSONC.parse(await BunRuntime.file(WRANGLER_CONFIG_PATH).text()) as {
    env?: { production?: { vars?: Record<string, string> } };
  };
  const vars = config.env?.production?.vars;
  if (!vars) throw new Error("wrangler.jsonc has no env.production.vars block");
  return vars;
})();

describe("production money-path invariant", () => {
  test("every production chain id belongs to a declared money path", () => {
    // The ratchet. A money path cannot appear in production without someone
    // declaring its posture here and, if it is testnet, proving the guard.
    // Silence is the failure mode this exists to prevent.
    const declared = new Set(MONEY_PATHS.map((path) => path.chainIdVar));
    const undeclared = Object.keys(productionVars)
      .filter((name) => name.endsWith("_CHAIN_ID"))
      .filter((name) => !declared.has(name));

    expect(undeclared).toEqual([]);
  });

  test("production declares every money path it is supposed to", () => {
    for (const path of MONEY_PATHS) {
      expect(
        productionVars[path.chainIdVar],
        `${path.label} is missing from production`,
      ).toBeDefined();
    }
  });

  test("missing production RPC credentials provably fail the real resolver closed", () => {
    // Credential-bearing RPC URLs are Worker secrets, never checked-in vars.
    // Resolving only the real production manifest must fail rather than choose
    // a public endpoint or silently disable settlement evidence.
    expect(() => loadConfigFrom(MoneyPathConfig, productionVars)).toThrow();
    expect(productionVars.COMMUNITY_PURCHASE_FUNDING_RPC_URL).toBeUndefined();
  });

  for (const path of MONEY_PATHS.filter((entry) => entry.posture === "mainnet_required")) {
    test(`${path.label} settles on Base mainnet`, () => {
      expect(Number(productionVars[path.chainIdVar])).toBe(BASE_MAINNET_CHAIN_ID);
    });
  }

  for (const path of MONEY_PATHS) {
    if (path.posture !== "guarded_testnet_exception") continue;

    test(`${path.label} is on a testnet only because its guard fails closed`, () => {
      const chainId = Number(productionVars[path.chainIdVar]);

      // Once the exception is retired the guard stops throwing, and this
      // test should be deleted along with the entry — not "fixed" by
      // loosening it.
      if (chainId === BASE_MAINNET_CHAIN_ID) {
        expect(path.assertFailsClosed(productionVars)).toBe(BASE_MAINNET_CHAIN_ID);
        return;
      }

      expect(
        KNOWN_TESTNET_CHAIN_IDS.has(chainId),
        `${path.chainIdVar}=${chainId} is neither mainnet nor a known testnet`,
      ).toBe(true);
      expect(() => path.assertFailsClosed(productionVars)).toThrow();
    });
  }

  test("mainnet money paths do not point at a testnet RPC or testnet USDC", () => {
    // A correct chain id with a Sepolia RPC or Sepolia USDC beside it is
    // the same defect wearing a different hat.
    const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    for (const path of MONEY_PATHS) {
      if (path.posture !== "mainnet_required") continue;
      const prefix = path.chainIdVar.replace(/_CHAIN_ID$/, "");

      const rpcUrl = productionVars[`${prefix}_RPC_URL`];
      if (rpcUrl) expect(rpcUrl, `${path.label} RPC`).not.toMatch(/sepolia/i);

      const usdc = productionVars[`${prefix}_USDC_TOKEN_ADDRESS`];
      if (usdc) expect(usdc.toLowerCase(), `${path.label} USDC`).not.toBe(SEPOLIA_USDC);
    }
  });
});
