import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  CommunityRouteExpiryRejected,
  type CommunityRouteExpiryStore,
  expireCommunityRouteEvidence,
} from "./expiry.ts";

describe("community route database-time expiry use case", () => {
  test("validates scheduler authority before calling its store", async () => {
    let calls = 0;
    const store: CommunityRouteExpiryStore = {
      expire: (input) => {
        calls += 1;
        expect(input).toEqual({
          family: "hns",
          limit: 1,
          principal_id: "route-expiry-scheduler",
        });
        return Effect.succeed({ selected: 1, transitioned: 1, stale: 0 });
      },
    };

    await expect(
      Effect.runPromise(
        expireCommunityRouteEvidence(
          { family: "hns", limit: 1, principal_id: "route-expiry-scheduler" },
          { store },
        ),
      ),
    ).resolves.toEqual({ selected: 1, transitioned: 1, stale: 0 });
    expect(calls).toBe(1);

    for (const invalid of [
      { family: "dns", limit: 1, principal_id: "route-expiry-scheduler" },
      { family: "hns", limit: 0, principal_id: "route-expiry-scheduler" },
      { family: "hns", limit: 1, principal_id: " route-expiry-scheduler" },
      { family: "hns", limit: 1, principal_id: "route-expiry-scheduler", extra: true },
    ]) {
      await expect(
        Effect.runPromise(expireCommunityRouteEvidence(invalid, { store })),
      ).rejects.toBeInstanceOf(CommunityRouteExpiryRejected);
    }
    expect(calls).toBe(1);
  });
});
