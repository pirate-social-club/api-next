import { deriveCommunityRoute } from "@pirate/domain";
import { describe, expect, test } from "vitest";

describe("route-label codec in workerd", () => {
  test("bundles the pinned TR46 data and canonicalizes Unicode and emoji", () => {
    expect(deriveCommunityRoute({ family: "hns", root_label: "MÜNCHEN" })).toMatchObject({
      kind: "accepted",
      value: {
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "app.xn--mnchen-3ya",
      },
    });
    expect(deriveCommunityRoute({ family: "spaces", root_label: "🔥" })).toMatchObject({
      kind: "accepted",
      value: {
        root_label: "xn--4v8h",
        root_label_display: "🔥",
        path_segment: "@xn--4v8h",
      },
    });
  });
});
