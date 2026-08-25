import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CommunityRouteLifecycleStatusV1,
  decodeCommunityCanonicalRouteV1,
  decodeCommunityCanonicalRouteV2,
  decodeCommunityRouteRequestV1,
} from "./community-routes.ts";

describe("community route contracts", () => {
  test("accepts bounded Unicode, emoji, compatibility, and ACE route requests", () => {
    for (const request of [
      { family: "hns", root_label: "jazleeuw" },
      { family: "hns", root_label: "münchen" },
      { family: "hns", root_label: "MÜNCHEN" },
      { family: "hns", root_label: "münchen" },
      { family: "hns", root_label: "xn--mnchen-3ya" },
      { family: "spaces", root_label: "🔥" },
      { family: "spaces", root_label: "ｆｏｏ" },
    ] as const) {
      expect(decodeCommunityRouteRequestV1(request)).toEqual(request);
    }

    for (const root_label of [
      "",
      "@music",
      "app.jazleeuw",
      "jazleeuw.",
      " jazleeuw",
      "jazleeuw ",
      "with/slash",
      "with\\slash",
      "percent%2Eescape",
      "control\u0000value",
      "a".repeat(256),
    ]) {
      expect(
        () => decodeCommunityRouteRequestV1({ family: "hns", root_label }),
        root_label,
      ).toThrow();
    }
    expect(() =>
      decodeCommunityRouteRequestV1({ family: "dns", root_label: "jazleeuw" }),
    ).toThrow();
    expect(() =>
      decodeCommunityRouteRequestV1({
        family: "hns",
        root_label: "jazleeuw",
        slug: "forged",
      }),
    ).toThrow();
  });

  test("accepts only structurally consistent family-specific canonical routes", () => {
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
        app_host: null,
      }),
    ).toMatchObject({ family: "hns", root_label_display: "münchen", app_host: null });
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "hns",
        root_label: "technohippies",
        root_label_display: "technohippies",
        path_segment: "app.technohippies",
        href: "/c/app.technohippies",
        app_host: "app.technohippies",
      }),
    ).toMatchObject({ family: "hns", app_host: "app.technohippies" });
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "spaces",
        root_label: "xn--4v8h",
        root_label_display: "🔥",
        path_segment: "@xn--4v8h",
        href: "/c/@xn--4v8h",
        app_host: null,
      }),
    ).toMatchObject({ family: "spaces", root_label_display: "🔥", app_host: null });
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "hns",
        root_label: "xn--58d",
        root_label_display: "Ꭰ",
        path_segment: "app.xn--58d",
        href: "/c/app.xn--58d",
        app_host: null,
      }),
    ).toMatchObject({ family: "hns", root_label_display: "Ꭰ" });

    for (const invalid of [
      {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "app.forged",
        href: "/c/app.xn--mnchen-3ya",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "test",
        root_label_display: "test",
        path_segment: "app.test",
        href: "/c/app.test",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "wrong",
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "xn--1",
        root_label_display: "xn--1",
        path_segment: "app.xn--1",
        href: "/c/app.xn--1",
        app_host: null,
      },
      {
        family: "spaces",
        root_label: "xn--123-pretty-valid-space-ok",
        root_label_display: "xn--123-pretty-valid-space-ok",
        path_segment: "@xn--123-pretty-valid-space-ok",
        href: "/c/@xn--123-pretty-valid-space-ok",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "MÜNCHEN",
        path_segment: "app.xn--mnchen-3ya",
        href: "/c/app.xn--mnchen-3ya",
        app_host: null,
      },
      {
        family: "spaces",
        root_label: "tame_impala",
        root_label_display: "tame_impala",
        path_segment: "@tame_impala",
        href: "/c/@tame_impala",
        app_host: null,
      },
      {
        family: "spaces",
        root_label: "music",
        root_label_display: "music",
        path_segment: "@music",
        href: "/c/@music",
        app_host: "app.music",
      },
    ]) {
      expect(() => decodeCommunityCanonicalRouteV1(invalid)).toThrow();
    }
    expect(() =>
      decodeCommunityCanonicalRouteV1({
        family: "spaces",
        root_label: "music",
        root_label_display: "music",
        path_segment: "@music",
        href: "/c/@music",
        app_host: null,
        route_slug: "forged",
      }),
    ).toThrow();
  });

  test("freezes route suspension separately from administrative visibility", () => {
    const decode = Schema.decodeUnknownSync(CommunityRouteLifecycleStatusV1);
    expect(decode("active")).toBe("active");
    expect(decode("suspended")).toBe("suspended");
    expect(() => decode("hidden")).toThrow();
    expect(() => decode("archived")).toThrow();
  });

  test("separates the public HNS route v2 path from the retained app host", () => {
    expect(
      decodeCommunityCanonicalRouteV2({
        family: "hns",
        root_label: "xn--mnchen-3ya",
        root_label_display: "münchen",
        path_segment: "xn--mnchen-3ya",
        href: "/c/xn--mnchen-3ya",
        app_host: "app.xn--mnchen-3ya",
      }),
    ).toMatchObject({ path_segment: "xn--mnchen-3ya", app_host: "app.xn--mnchen-3ya" });
    expect(
      decodeCommunityCanonicalRouteV2({
        family: "hns",
        root_label: "community_music",
        root_label_display: "community_music",
        path_segment: "community_music",
        href: "/c/community_music",
        app_host: null,
      }),
    ).toMatchObject({ root_label: "community_music" });
    for (const root_label of ["pirate", "community_123e4567-e89b-42d3-a456-426614174000"]) {
      expect(() =>
        decodeCommunityCanonicalRouteV2({
          family: "hns",
          root_label,
          root_label_display: root_label,
          path_segment: root_label,
          href: `/c/${root_label}`,
          app_host: null,
        }),
      ).toThrow();
    }
    expect(() =>
      decodeCommunityCanonicalRouteV2({
        family: "hns",
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: "app.jazleeuw",
      }),
    ).toThrow();
  });
});
