import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneResult,
  ControlPlaneStatement,
  ControlPlaneTransaction,
} from "@pirate/application";
import { Effect } from "effect";
import {
  ensurePostSlugAliasInTransaction,
  PublicPostSlugRepositoryError,
} from "./public-post-slug-repository.ts";

type Row = Readonly<Record<string, unknown>>;
type Result = Readonly<{ rows: readonly Row[]; rowCount?: number }>;

const timestamp = "2026-09-01T12:00:00.000Z";
const aliasRow = (slug: string, postId = "post-1"): Row => ({
  slug,
  post_id: postId,
  slug_policy_version: "post-slug-v1",
  created_at: timestamp,
});

const transactionFor = (
  handler: (statement: ControlPlaneStatement) => Result,
): ControlPlaneTransaction => ({
  execute: <Output = unknown>(statement: ControlPlaneStatement) => {
    const result = handler(statement);
    return Effect.succeed({
      rows: result.rows as readonly Output[],
      rowCount: result.rowCount ?? result.rows.length,
    } satisfies ControlPlaneResult<Output>);
  },
});

describe("public post slug allocation", () => {
  test("returns the immutable existing alias without inserting", async () => {
    const labels: string[] = [];
    const transaction = transactionFor((statement) => {
      labels.push(statement.label);
      return { rows: [aliasRow("existing-slug")] };
    });

    await expect(
      Effect.runPromise(
        ensurePostSlugAliasInTransaction(transaction, {
          postId: "post-1",
          candidate: { kind: "descriptive", branch: "ascii", slug: "new-title" },
        }),
      ),
    ).resolves.toEqual({
      slug: "existing-slug",
      postId: "post-1",
      slugPolicyVersion: "post-slug-v1",
      createdAt: timestamp,
    });
    expect(labels).toEqual(["public-post-slug.lookup-by-post-id"]);
  });

  test("allocates base-3 after same-title conflicts", async () => {
    const insertedSlugs: string[] = [];
    let lookupCount = 0;
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.lookup-by-post-id") {
        lookupCount += 1;
        return { rows: [] };
      }
      const slug = statement.values[0];
      if (typeof slug !== "string") throw new Error("expected slug parameter");
      insertedSlugs.push(slug);
      return slug === "same-title-3" ? { rows: [aliasRow(slug)] } : { rows: [] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(transaction, {
        postId: "post-1",
        candidate: { kind: "descriptive", branch: "ascii", slug: "same-title" },
      }),
    );

    expect(result.slug).toBe("same-title-3");
    expect(insertedSlugs).toEqual(["same-title", "same-title-2", "same-title-3"]);
    expect(lookupCount).toBe(3);
  });

  test("observes the winner of a same-post race", async () => {
    let lookupCount = 0;
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.insert") return { rows: [] };
      lookupCount += 1;
      return lookupCount === 1 ? { rows: [] } : { rows: [aliasRow("race-winner")] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(transaction, {
        postId: "post-1",
        candidate: { kind: "descriptive", branch: "ascii", slug: "candidate" },
      }),
    );

    expect(result.slug).toBe("race-winner");
    expect(lookupCount).toBe(2);
  });

  test("regenerates opaque tokens after a slug collision", async () => {
    const tokens = ["0000000000", "1111111111"];
    const insertedSlugs: string[] = [];
    const transaction = transactionFor((statement) => {
      if (statement.label === "public-post-slug.lookup-by-post-id") return { rows: [] };
      const slug = statement.values[0];
      if (typeof slug !== "string") throw new Error("expected slug parameter");
      insertedSlugs.push(slug);
      return slug === "song-1111111111" ? { rows: [aliasRow(slug)] } : { rows: [] };
    });

    const result = await Effect.runPromise(
      ensurePostSlugAliasInTransaction(
        transaction,
        { postId: "post-1", candidate: { kind: "opaque", prefix: "song" } },
        { nextOpaqueToken: () => tokens.shift() ?? "2222222222" },
      ),
    );

    expect(result.slug).toBe("song-1111111111");
    expect(insertedSlugs).toEqual(["song-0000000000", "song-1111111111"]);
  });

  test("fails closed on invalid injected entropy", async () => {
    const transaction = transactionFor(() => ({ rows: [] }));

    await expect(
      Effect.runPromise(
        ensurePostSlugAliasInTransaction(
          transaction,
          { postId: "post-1", candidate: { kind: "opaque", prefix: "post" } },
          { nextOpaqueToken: () => "contains-u" },
        ),
      ),
    ).rejects.toBeInstanceOf(PublicPostSlugRepositoryError);
  });
});
