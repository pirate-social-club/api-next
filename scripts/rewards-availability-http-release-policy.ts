import { HTTP_RELEASE } from "./public-post-http-release-core.ts";
import { HTTP_PATHS, type HttpSourcePolicy } from "./public-post-http-release-source.ts";

/** A single reviewed operation. No CLI or environment input selects this policy. */
export const REWARDS_AVAILABILITY_HTTP: HttpSourcePolicy = {
  reviewKind: "rewards-availability-http-operation-review-v1",
  release: {
    ...HTTP_RELEASE,
    source: "8ad7bdea62e418a8a67efa5fc791797a196fe7fe",
    tree: "06df51384b927c9aefe2d1cb412774005b81f855",
    base: "b0b88a075fbe24b59bb69650a39bb3cff563e514",
    accepted: "236f5a67de0d66b8c832116cfde619fe168eebf0",
    baseline: "2aec3dce-96dd-49d3-8895-026cd12ac64a",
    module: "2e47a64ad16579c217a0ca6110086cec22c706ae96ec56f1fe44767a7d88c130",
    packet: "08a9d4dc388b6bf5047016ca54b355fdf0d949eb8853bd3f707dc03d969eccf4",
  },
  paths: {
    tooling: HTTP_PATHS.tooling,
    application:
      "/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/api-rewards-availability-runtime-20261102",
    packet:
      "/media/t42/codedrive/Code/pirate-workspace/.archive/rewards-availability-runtime-20261102/application-artifact",
    evidence:
      "/media/t42/codedrive/Code/pirate-workspace/.archive/rewards-availability-runtime-20261102/release-execution",
  },
  applicationBranch: "release/production-rewards-availability-20261102",
  changedPaths: [
    "apps/http-worker/src/composition.test.ts",
    "apps/http-worker/src/composition.ts",
    "apps/http-worker/src/rewards-song-offer-handlers.test.ts",
    "apps/http-worker/src/rewards-song-offer-handlers.ts",
    "packages/contracts/src/registry.ts",
    "packages/contracts/src/rewards-song-offers.test.ts",
    "packages/contracts/src/rewards-song-offers.ts",
  ],
  recoveryMessage: "Rewards availability HTTP baseline recovery",
};
