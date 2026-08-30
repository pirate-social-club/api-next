import { describe, expect, test } from "bun:test";
import { makeHnsCommunityAppHandleGatewayComposition } from "./combined-composition.ts";
import type { HnsCommunityAppGatewayComposition } from "./community-composition.ts";
import type { HnsCommunityHandleGatewayComposition } from "./handle-composition.ts";
import type { HnsStaticPlatformGatewayRequest } from "./request.ts";

function request(
  hostFields: readonly (readonly [string, string])[],
): HnsStaticPlatformGatewayRequest {
  return {
    method: "GET",
    target: "/",
    header_fields: hostFields,
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
  };
}

function service(kind: "community" | "handle") {
  return Object.freeze({
    handle: async () => new Response(null, { status: 200, headers: { "x-selected": kind } }),
  });
}

function composition() {
  return makeHnsCommunityAppHandleGatewayComposition(true, {
    community_app: { enabled: true, service: service("community") } satisfies Extract<
      HnsCommunityAppGatewayComposition,
      { enabled: true }
    >,
    handle_host: { enabled: true, service: service("handle") } satisfies Extract<
      HnsCommunityHandleGatewayComposition,
      { enabled: true }
    >,
  });
}

describe("combined community app and handle gateway composition", () => {
  test("dispatches the exact app label to the community service", async () => {
    const result = composition();
    if (!result.enabled) throw new Error("test composition is disabled");
    for (const authority of ["app.jazleeuw", "app.jazleeuw:443"]) {
      const response = await result.service.handle(request([["host", authority]]));
      expect(response.headers.get("x-selected")).toBe("community");
    }
  });

  test("dispatches subordinate labels to the handle service", async () => {
    const result = composition();
    if (!result.enabled) throw new Error("test composition is disabled");
    const response = await result.service.handle(request([["host", "pilotuser.jazleeuw"]]));
    expect(response.headers.get("x-selected")).toBe("handle");
  });

  test("leaves malformed, mixed-case, and duplicate authorities to fail in handle admission", async () => {
    const result = composition();
    if (!result.enabled) throw new Error("test composition is disabled");
    for (const fields of [
      [] as const,
      [["host", "App.jazleeuw"]] as const,
      [
        ["host", "app.jazleeuw"],
        ["host", "app.jazleeuw"],
      ] as const,
    ]) {
      const response = await result.service.handle(request(fields));
      expect(response.headers.get("x-selected")).toBe("handle");
    }
  });

  test("requires both source-closed child compositions", () => {
    expect(() => makeHnsCommunityAppHandleGatewayComposition(true)).toThrow(
      "composition is incomplete or invalid",
    );
  });
});
