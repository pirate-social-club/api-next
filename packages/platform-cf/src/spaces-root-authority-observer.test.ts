import { describe, expect, test } from "bun:test";
import { makeSpacesRootAuthorityObserver } from "./spaces-root-authority-observer.ts";

const credentials = {
  accessClientId: "test-id",
  accessClientSecret: "test-secret",
  bearerToken: "test-bearer",
};

describe("Spaces root authority observer", () => {
  test("treats verifier 409 as pending without deriving a changed root", async () => {
    const mockFetch = (async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "CF-Access-Client-Id": "test-id",
        "CF-Access-Client-Secret": "test-secret",
        authorization: "Bearer test-bearer",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ root: "@yahoo" });
      return new Response(null, { status: 409 });
    }) as typeof fetch;
    const observer = makeSpacesRootAuthorityObserver(credentials, mockFetch);
    expect(await observer.observe({ canonicalRoot: "yahoo" })).toEqual({ kind: "pending" });
  });

  test("refuses incomplete credentials and an oversized verifier response", async () => {
    expect(() => makeSpacesRootAuthorityObserver({ ...credentials, bearerToken: "" })).toThrow();
    const observer = makeSpacesRootAuthorityObserver(
      credentials,
      (async () => new Response("a".repeat(65_537), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(observer.observe({ canonicalRoot: "yahoo" })).rejects.toThrow("bound");
  });
});
