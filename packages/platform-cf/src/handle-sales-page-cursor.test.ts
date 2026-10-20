import { describe, expect, test } from "bun:test";
import { HandleSalesPageRejected } from "@pirate/application";
import { decodePageCursor, encodePageCursor, pageLimit } from "./handle-sales-page-cursor.ts";

describe("unchanged handle page cursor boundary", () => {
  const cursor = {
    snapshotCutoff: "2026-10-20T00:00:00.000Z",
    sortTime: "2026-10-19T00:00:00.000Z",
    sortId: "offering_fixture",
  };

  test("keeps the existing operation-scoped wire and snapshot ordering", () => {
    const wire = encodePageCursor("offerings", "community_fixture", cursor);
    expect(wire.startsWith("hcp1.")).toBe(true);
    expect(decodePageCursor(wire, "offerings", "community_fixture")).toEqual(cursor);
    expect(decodePageCursor(undefined, "offerings", "community_fixture")).toBeNull();
  });

  test("does not let discovery pagination cross community or operation boundaries", () => {
    const wire = encodePageCursor("offerings", "community_fixture", cursor);
    expect(() => decodePageCursor(wire, "offerings", "another_community")).toThrow(
      HandleSalesPageRejected,
    );
    expect(() => decodePageCursor(wire, "persona_grants", "community_fixture")).toThrow(
      HandleSalesPageRejected,
    );
  });

  test("rejects a future sort boundary and malformed cursor without weakening limits", () => {
    const future = encodePageCursor("offerings", "community_fixture", {
      ...cursor,
      sortTime: "2026-10-21T00:00:00.000Z",
    });
    expect(() => decodePageCursor(future, "offerings", "community_fixture")).toThrow(
      HandleSalesPageRejected,
    );
    for (const wire of ["hcp1.!", "hcp1.e30", "another.version"])
      expect(() => decodePageCursor(wire, "offerings", "community_fixture")).toThrow(
        HandleSalesPageRejected,
      );
    expect(pageLimit(undefined)).toBe(20);
    expect(pageLimit(100)).toBe(100);
    for (const limit of [0, 101, Number.NaN])
      expect(() => pageLimit(limit)).toThrow(HandleSalesPageRejected);
  });
});
