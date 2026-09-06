import { describe, expect, test } from "bun:test";
import { inspectKaraokeResetMarker, transitionKaraokeResetMarker } from "./karaoke-reset-marker.ts";

const identity = {
  namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
  objectId: "a".repeat(64),
  generation: "staging-reset-v1",
};
const active = { version: 1, ...identity, state: "active" } as const;

describe("Karaoke reset marker protocol", () => {
  test("only an absent storage value allows business work", () => {
    expect(inspectKaraokeResetMarker(undefined, identity)).toEqual({ state: "absent" });
    for (const value of [null, false, 0, "", {}, { ...active, version: 2 }]) {
      expect(inspectKaraokeResetMarker(value, identity)).toEqual({ state: "invalid" });
    }
  });

  test("active and retired markers deny independently of environment flags", () => {
    expect(inspectKaraokeResetMarker(active, identity).state).toBe("active");
    expect(inspectKaraokeResetMarker({ ...active, state: "retired" }, identity).state).toBe(
      "retired",
    );
  });

  test("object, namespace, generation and unexpected fields fail closed", () => {
    for (const patch of [
      { objectId: "b".repeat(64) },
      { namespaceId: "b".repeat(32) },
      { generation: "another-reset" },
      { extra: "must-not-be-accepted" },
    ]) {
      expect(inspectKaraokeResetMarker({ ...active, ...patch }, identity).state).toBe("invalid");
    }
  });

  test("installation is idempotent and retirement cannot be reversed", () => {
    const installed = transitionKaraokeResetMarker(undefined, identity, "active");
    expect(installed).toEqual(active);
    expect(transitionKaraokeResetMarker(installed, identity, "active")).toEqual(active);
    const retired = transitionKaraokeResetMarker(installed, identity, "retired");
    expect(retired.state).toBe("retired");
    expect(transitionKaraokeResetMarker(retired, identity, "retired")).toEqual(retired);
    expect(() => transitionKaraokeResetMarker(retired, identity, "active")).toThrow(
      "karaoke_reset_retired",
    );
    expect(Object.isFrozen(retired)).toBe(true);
  });

  test("retirement requires a matching installed marker", () => {
    expect(() => transitionKaraokeResetMarker(undefined, identity, "retired")).toThrow(
      "karaoke_reset_not_installed",
    );
    for (const value of [null, { ...active, generation: "other" }]) {
      expect(() => transitionKaraokeResetMarker(value, identity, "active")).toThrow(
        "karaoke_reset_invalid_marker",
      );
    }
  });

  test("invalid commands cannot create a marker", () => {
    expect(() =>
      transitionKaraokeResetMarker(undefined, { ...identity, objectId: "bad" }, "active"),
    ).toThrow("karaoke_reset_invalid_command");
    expect(() => transitionKaraokeResetMarker(undefined, identity, "clear" as "active")).toThrow(
      "karaoke_reset_invalid_command",
    );
  });
});
