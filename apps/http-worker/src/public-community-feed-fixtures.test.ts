import { expect, test } from "bun:test";
import { ApiClientError, createPirateApiClient } from "../../../packages/api-client/src/index.ts";

for (const name of ["mixed", "public-only", "locked-only", "empty", "missing", "failed"]) {
  test(`HTTP ${name} fixture decodes through the generated Community client`, async () => {
    const fixture = await Bun.file(
      new URL(`./fixtures/public-community-feed/${name}.json`, import.meta.url),
    ).json();
    const client = createPirateApiClient("https://fixture.invalid", {
      fetchImpl: Object.assign(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          new Response(JSON.stringify(fixture.body), {
            status: fixture.status,
            headers: fixture.headers,
          }),
        { preconnect: () => undefined },
      ),
    });
    const response = client.get_publicCommunitiesCommunityRefFeed({
      path: { communityRef: "feed-fixture" },
      query: { surface: "threads", sort: "new" },
    });
    if (fixture.status === 200) expect(await response).toEqual(fixture.body);
    else {
      const error = await response.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ApiClientError);
      if (!(error instanceof ApiClientError)) throw new Error("Expected declared client error");
      expect(error.status).toBe(fixture.status);
      expect(error.code).toBe(fixture.body.error.code);
    }
  });
}
