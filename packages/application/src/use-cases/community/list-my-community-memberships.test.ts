import { describe, expect, test } from "bun:test";
import { BadRequest, InternalError } from "@pirate/contracts";
import { Effect } from "effect";
import { CommunityRepositoryError, type CommunityStoreService } from "../../ports.ts";
import { listMyCommunityMemberships } from "./list-my-community-memberships.ts";

const page = {
  object: "account_community_membership_page" as const,
  items: [],
  next_cursor: null,
};

const services = (listAccountMemberships: CommunityStoreService["listAccountMemberships"]) => ({
  communityStore: { listAccountMemberships } as CommunityStoreService,
});

describe("listMyCommunityMemberships", () => {
  test("passes only the authenticated account and decoded page query", async () => {
    const observed: unknown[] = [];
    await expect(
      Effect.runPromise(
        listMyCommunityMemberships(
          { userId: "user-a", query: { cursor: "opaque", limit: "25" } },
          services((input) => {
            observed.push(input);
            return Effect.succeed(page);
          }),
        ),
      ),
    ).resolves.toEqual(page);
    expect(observed).toEqual([{ userId: "user-a", query: { cursor: "opaque", limit: "25" } }]);
  });

  test("maps invalid account and cursor input to BadRequest", async () => {
    await expect(
      Effect.runPromise(
        listMyCommunityMemberships(
          { userId: " user-a", query: {} },
          services(() => Effect.succeed(page)),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      Effect.runPromise(
        listMyCommunityMemberships(
          { userId: "user-a", query: { cursor: "bad" } },
          services(() =>
            Effect.fail(
              new CommunityRepositoryError({
                operation: "list-memberships",
                reason: "invalid-cursor",
              }),
            ),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
  });

  test("redacts repository failures", async () => {
    await expect(
      Effect.runPromise(
        listMyCommunityMemberships(
          { userId: "user-a", query: {} },
          services(() =>
            Effect.fail(
              new CommunityRepositoryError({
                operation: "list-memberships",
                reason: "invalid-row",
              }),
            ),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(InternalError);
  });
});
