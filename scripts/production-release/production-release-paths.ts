import { fileURLToPath } from "node:url";

export const SOURCE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
export const TOOLING_REPO = fileURLToPath(new URL("../../", import.meta.url));
export const APP_REPO =
  "/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/v1-self-dependency-advisories-20261031";
export const API_APP_SOURCE = "6862fa976a2fc387ee0e0274ba9f1b2abc447427";
export const API_APP_TREE = "4ed603e6dca5bb9fd34f9aa0addb94cd8d99b471";
export const WEBSITE_SOURCE = "2df88cf0200fb30535d4d3b5b1034b390e024c51";
export const WEBSITE_EXECUTOR =
  "/media/t42/codedrive/Code/pirate-workspace/.worktrees/pirate-web-solid/solid-website-production-executor-20261031/scripts/production-website-cutover.mjs";
export const QUALIFICATION =
  "/media/t42/codedrive/Code/pirate-workspace/.archive/v1-shared-launch-execution-20261023/checkpoints-20261030/final-production-qualification-a6-333/";
export const EVIDENCE_ROOT = QUALIFICATION + "website-production-operation-20261031/";
export const OPERATION_DIR = EVIDENCE_ROOT + "operation/";
export const JOURNAL_DIR = EVIDENCE_ROOT + "execution-journal/";
export const FACTS_PATH = EVIDENCE_ROOT + "live-facts.json";
