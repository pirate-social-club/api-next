import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { draftStagingPrivilegeProposal } from "./staging-persona-privilege-proposal";

test("the review artifact is reproducible, includes identity sequences and grants no authority", () => {
  const draft = draftStagingPrivilegeProposal();
  expect(draft).toEqual(
    JSON.parse(
      readFileSync(
        new URL("../docs/staging-persona-runtime-privileges.draft.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(draft.execution_authorized).toBe(false);
  expect(draft.entries.filter((entry) => entry.kind === "table")).toHaveLength(349);
  expect(draft.entries.filter((entry) => entry.kind === "sequence")).toHaveLength(2);
  expect(draft.entries.some((entry) => entry.object === "api_next.schema_migrations")).toBe(false);
  expect(draft.entries.every((entry) => entry.grant_option === false)).toBe(true);
});
