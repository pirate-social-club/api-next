import { fileURLToPath } from "node:url";

export const SOURCE_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
export const TOOLING_REPO = fileURLToPath(new URL("../../", import.meta.url));
export const APP_REPO =
  "/media/t42/codedrive/Code/pirate-workspace/.worktrees/api-next/v1-hns-browser-renewal-cookies-api-20261029";
export const API_APP_SOURCE = "a6bb14b7669ec5900d20b20d1fb077a5bead38bc";
export const API_APP_TREE = "ba935ba8fdc0526f1a6c0b251a75027314034900";
export const WEBSITE_SOURCE = "2df88cf0200fb30535d4d3b5b1034b390e024c51";
export const WEBSITE_EXECUTOR =
  "/media/t42/codedrive/Code/pirate-workspace/.worktrees/pirate-web-solid/solid-website-production-executor-20261031/scripts/production-website-cutover.mjs";
export const QUALIFICATION =
  "/media/t42/codedrive/Code/pirate-workspace/.archive/v1-shared-launch-execution-20261023/checkpoints-20261030/final-production-qualification-a6-333/";
export const EVIDENCE_ROOT = QUALIFICATION + "website-production-operation-20261031/";
export const OPERATION_DIR = EVIDENCE_ROOT + "operation/";
export const JOURNAL_DIR = EVIDENCE_ROOT + "execution-journal/";
export const FACTS_PATH = EVIDENCE_ROOT + "live-facts.json";
