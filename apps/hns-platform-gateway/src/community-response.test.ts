import { describe, expect, test } from "bun:test";
import { sanitizeHnsCommunityAppGatewayResponse } from "./community-response.ts";

const issue = [
  "__Host-pirate_session=access; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600",
  "__Host-pirate_renewal=renewal; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000",
  "__Host-pirate_csrf=csrf; Path=/; Secure; SameSite=Lax; Max-Age=2592000",
];
const cleared = issue.map((line) =>
  line
    .replace(/=[^;]*/u, "=")
    .replace(/Max-Age=\d+/u, "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"),
);
function response(cookies: readonly string[]) {
  const upstream = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  for (const cookie of cookies) upstream.headers.append("set-cookie", cookie);
  return upstream;
}

describe("community HNS owned browser cookie boundary", () => {
  for (const [operation, cookies] of [
    ["issue", issue],
    ["renew", issue.map((line) => line.replace("=access;", "=renewed;"))],
    ["logout", cleared],
  ] as const) {
    test(`preserves all three correctly scoped ${operation} cookies`, async () => {
      const result = await sanitizeHnsCommunityAppGatewayResponse(
        response(cookies),
        "POST",
        "app.example.test",
      );
      expect(result.status).toBe(200);
      expect(result.headers.getSetCookie()).toEqual(cookies);
      expect(result.headers.get("cache-control")).toBe("no-store");
    });
  }
  for (const [condition, cookies] of [
    [
      "renewal without HttpOnly",
      issue.map((line) =>
        line.startsWith("__Host-pirate_renewal=") ? line.replace("; HttpOnly", "") : line,
      ),
    ],
    [
      "readable session",
      issue.map((line) =>
        line.startsWith("__Host-pirate_session=") ? line.replace("; HttpOnly", "") : line,
      ),
    ],
    [
      "HttpOnly CSRF",
      issue.map((line) => (line.startsWith("__Host-pirate_csrf=") ? line + "; HttpOnly" : line)),
    ],
    ["unknown cookie", [...issue, "__Host-pirate_other=value; Path=/; Secure; SameSite=Lax"]],
    ["duplicate renewal", [...issue, issue[1]!]],
    ["Domain attribute", issue.map((line) => line + "; Domain=example.test")],
    ["missing Secure", issue.map((line) => line.replace("; Secure", ""))],
  ] as const) {
    test(`refuses ${condition}`, async () => {
      await expect(
        sanitizeHnsCommunityAppGatewayResponse(response(cookies), "POST", "app.example.test"),
      ).rejects.toThrow("Upstream response is invalid");
    });
  }
});
