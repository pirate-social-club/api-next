import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseCommunitySessionHotfixOperation } from "./community-session-sufficiency-hotfix.ts";
import { AFTER_BODY, BEFORE_BODY } from "./community-session-sufficiency-hotfix-sql.ts";

describe("community session sufficiency hotfix", () => {
  test("binds the compatibility function bodies to reviewed digests", () => {
    expect(createHash("sha256").update(BEFORE_BODY).digest("hex")).toBe(
      "80c3e8881805b5f93771b50e06292a421460ce8ae46433fb8ff87b8123a912d7",
    );
    expect(createHash("sha256").update(AFTER_BODY).digest("hex")).toBe(
      "767069b6185991d040c4c50cc990de7da8e6a113134d4d973012363f9257533d",
    );
  });

  test("requires an exact operation-specific confirmation", () => {
    expect(parseCommunitySessionHotfixOperation(["inspect"])).toBe("inspect");
    expect(
      parseCommunitySessionHotfixOperation([
        "apply",
        "--confirm",
        "apply-community-session-sufficiency-hotfix",
      ]),
    ).toBe("apply");
    expect(
      parseCommunitySessionHotfixOperation([
        "restore",
        "--confirm",
        "restore-community-session-sufficiency-hotfix",
      ]),
    ).toBe("restore");
    expect(() => parseCommunitySessionHotfixOperation(["apply"])).toThrow(
      "community_session_hotfix_invalid_arguments",
    );
    expect(() =>
      parseCommunitySessionHotfixOperation([
        "apply",
        "--confirm",
        "restore-community-session-sufficiency-hotfix",
      ]),
    ).toThrow("community_session_hotfix_confirmation_mismatch");
  });
});
