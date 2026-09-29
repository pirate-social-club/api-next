/** Leaf exports used by the jobs runtime must resolve to source inside workerd. */
export const rewardsPlatformAliases = Object.fromEntries(
  [
    "custody-solvency-coordinator",
    "custody-solvency-repository",
    "megapot-approval-coordinator",
    "megapot-approval-repository",
    "megapot-claim-coordinator",
    "megapot-claim-repository",
    "megapot-commitment-coordinator",
    "megapot-commitment-r2",
    "megapot-commitment-repository",
    "megapot-drawing-observation-repository",
    "megapot-drawing-observer",
    "megapot-purchase-coordinator",
    "megapot-purchase-repository",
    "megapot-sweep-coordinator",
    "megapot-sweep-repository",
    "megapot-v2-rpc",
    "megapot-v2-signer",
    "reward-payout-coordinator",
    "reward-payout-repository",
    "reward-refund-coordinator",
    "reward-refund-repository",
  ].map((name) => [
    `@pirate/platform-cf/${name}`,
    new URL(`../packages/platform-cf/src/${name}.ts`, import.meta.url).pathname,
  ]),
);
