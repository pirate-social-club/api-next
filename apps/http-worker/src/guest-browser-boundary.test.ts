import { describe, expect, test } from "bun:test";
import { endpoints, guestParticipationRegistry } from "@pirate/contracts";
import { assertSupportedAuthPolicies } from "./auth-policy.ts";
import { redactDiagnosticText } from "./failure-diagnostics.ts";
import { parseGuestBrowserCookies } from "./guest-browser-cookie-policy.ts";
import { createHttpWorker } from "./transport.ts";

const secret = `${"x".repeat(42)}A`;
const credential = (index: number) => `${String.fromCharCode(65 + index).repeat(21)}A`;
const cookies = (count: number, intent = false) =>
  Array.from(
    { length: count },
    (_, index) => `__Host-pirate_guest_${intent ? "attach_" : ""}${credential(index)}=${secret}`,
  ).join("; ");

describe("guest browser boundary stays disabled", () => {
  test("ordinary policy validation still boots with the closed new vocabulary", () => {
    expect(() => assertSupportedAuthPolicies(endpoints)).not.toThrow();
  });
  test("all21 declared operations refuse without reading bodies or invoking supplied handlers/auth", async () => {
    let calls = 0;
    const worker = createHttpWorker({
      handlers: Object.fromEntries(
        Object.keys(guestParticipationRegistry).map((name) => [
          name,
          () => {
            calls += 1;
            throw new Error("must remain disabled");
          },
        ]),
      ),
    });
    for (const definition of Object.values(guestParticipationRegistry)) {
      const path = definition.path.replace(/:[A-Za-z]+/gu, "fixture");
      let bodyRead = false;
      const body =
        definition.method === "GET"
          ? undefined
          : new ReadableStream(
              {
                pull(controller) {
                  bodyRead = true;
                  controller.error(new Error("body must remain unread"));
                },
              },
              { highWaterMark: 0 },
            );
      const response = await worker.fetch(
        new Request(`https://fixture.invalid${path}`, {
          method: definition.method,
          ...(body === undefined ? {} : { body, duplex: "half" }),
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.has("set-cookie")).toBe(false);
      expect(bodyRead).toBe(false);
    }
    expect(calls).toBe(0);
    expect((await worker.fetch(new Request("https://fixture.invalid/health"))).status).toBe(200);
  });
  test("hard byte/count caps, malformed and duplicate unselected proofs fail before a store exists", () => {
    expect(
      parseGuestBrowserCookies(new Headers({ cookie: cookies(4) }), false).credentials,
    ).toHaveLength(4);
    expect(() => parseGuestBrowserCookies(new Headers({ cookie: cookies(5) }), false)).toThrow();
    expect(
      parseGuestBrowserCookies(new Headers({ cookie: cookies(16) }), true).credentials,
    ).toHaveLength(16);
    expect(() => parseGuestBrowserCookies(new Headers({ cookie: cookies(17) }), true)).toThrow();
    expect(() =>
      parseGuestBrowserCookies(new Headers({ cookie: cookies(5, true) }), false),
    ).toThrow();
    expect(
      parseGuestBrowserCookies(new Headers({ cookie: cookies(16, true) }), true).intents,
    ).toHaveLength(16);
    expect(() =>
      parseGuestBrowserCookies(new Headers({ cookie: `${cookies(1)}; ${cookies(1)}` }), true),
    ).toThrow();
    for (const value of ["", "%78".repeat(43), `${secret}=`, "short"])
      expect(() =>
        parseGuestBrowserCookies(
          new Headers({ cookie: `__Host-pirate_guest_${credential(0)}=${value}` }),
          false,
        ),
      ).toThrow();
    expect(() =>
      parseGuestBrowserCookies(new Headers({ cookie: `__Host-pirate_guest_bad=${secret}` }), false),
    ).toThrow();
    expect(() =>
      parseGuestBrowserCookies(new Headers({ cookie: `ordinary=${"x".repeat(16_385)}` }), false),
    ).toThrow();
  });
  test("diagnostics scrub dynamic ceremony/credential assignments including base64url punctuation", () => {
    for (const prefix of ["__Host-pirate_guest_", "__Host-pirate_guest_attach_"]) {
      const value = `failed ${prefix}${credential(0)}=${secret.replaceAll("x", "_")} tail`;
      expect(redactDiagnosticText(value)).toBe("failed guest-cookie=[redacted]");
    }
  });
});
