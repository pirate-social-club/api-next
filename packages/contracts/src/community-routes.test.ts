import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CommunityRouteLifecycleStatusV1,
  decodeCommunityCanonicalRouteV1,
  decodeCommunityRouteRequestV1,
} from "./community-routes.ts";

describe("community route contracts", () => {
  test("accepts only exact v1 HNS and Spaces route requests", () => {
    expect(decodeCommunityRouteRequestV1({ family: "hns", root_label: "jazleeuw" })).toEqual({
      family: "hns",
      root_label: "jazleeuw",
    });
    expect(decodeCommunityRouteRequestV1({ family: "spaces", root_label: "music" })).toEqual({
      family: "spaces",
      root_label: "music",
    });
    for (const root_label of [
      "",
      "Jazleeuw",
      "@music",
      "app.jazleeuw",
      "jazleeuw.",
      "two--hyphens",
      "-leading",
      "trailing-",
      "with/slash",
      "with\\slash",
      "percent%2Eescape",
      "müsic",
      "a".repeat(64),
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

  test("accepts only internally consistent derived canonical routes", () => {
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "hns",
        root_label: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: null,
      }),
    ).toMatchObject({ family: "hns", app_host: null });
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "hns",
        root_label: "technohippies",
        path_segment: "app.technohippies",
        href: "/c/app.technohippies",
        app_host: "app.technohippies",
      }),
    ).toMatchObject({ family: "hns", app_host: "app.technohippies" });
    expect(
      decodeCommunityCanonicalRouteV1({
        family: "spaces",
        root_label: "music",
        path_segment: "@music",
        href: "/c/@music",
        app_host: null,
      }),
    ).toMatchObject({ family: "spaces", app_host: null });

    for (const invalid of [
      {
        family: "hns",
        root_label: "jazleeuw",
        path_segment: "app.forged",
        href: "/c/app.jazleeuw",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/opaque-id",
        app_host: null,
      },
      {
        family: "hns",
        root_label: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: "app.forged",
      },
      {
        family: "spaces",
        root_label: "music",
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
});
