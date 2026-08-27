import { afterAll, describe, expect, test } from "bun:test";
import { PublicCommunityThreadsRepositoryError } from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";
import { makeControlPlanePublicCommunityThreadsRepository } from "./public-community-threads-repository.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_PUBLIC_COMMUNITY_THREADS_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-public-community-threads-suite-complete";
const sentinelContents =
  "api-next-control-plane-postgres-public-community-threads-suite-complete\n";
let completedTestCount = 0;

const migrations = await loadPostgresMigrations();

const schemaIdentifier = (): string =>
  `api_next_public_threads_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (connection: string, admin: Client) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    return await use(connectionForSchema(connectionString, schema), admin);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

async function apply(connection: string): Promise<void> {
  await Effect.runPromise(
    Effect.scoped(
      applyPostgresMigrations(migrations).pipe(
        Effect.provide(makeDirectPostgresControlPlaneLayer(connection)),
      ),
    ),
  );
}

const request = (communityRef: string, query: Record<string, unknown> = {}) => ({
  communityRef,
  slugCandidate: (() => {
    const candidate = decodeURIComponent(communityRef).normalize("NFKC").toLowerCase();
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate) ? candidate : null;
  })(),
  query: { surface: "threads" as const, sort: "new" as const, ...query },
});

const requireDocument = <A>(value: A | null): A => {
  if (value === null) throw new Error("expected a public community threads document");
  return value;
};

suite("Postgres 17 public community threads repository", () => {
  test("resolves safely, filters public text posts, and paginates without overlap", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      const base = new Date("2026-08-17T12:00:00.000Z");
      await admin.query("INSERT INTO users (user_id) VALUES ('usr_author'), ('usr_other')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        `INSERT INTO communities
          (community_id, route_slug, display_name, status, created_by_user_id, created_at, updated_at)
         VALUES
          ('collision', 'exact-community', 'Exact', 'active', 'usr_author', $1, $1),
          ('community-slug', 'collision', 'Slug', 'active', 'usr_author', $1, $1),
          ('community_1', 'community-one', 'Underscore ID', 'active', 'usr_author', $1, $1),
          ('community-current', 'current-community', 'Current', 'active', 'usr_author', $1, $1),
          ('community-hidden', 'hidden-community', 'Hidden', 'hidden', 'usr_author', $1, $1),
          ('community-other', 'other-community', 'Other', 'active', 'usr_other', $1, $1)`,
        [base],
      );
      for (let index = 0; index < 22; index += 1) {
        const created = new Date(base.getTime() - index * 1_000);
        await admin.query(
          `INSERT INTO posts
            (community_id, post_id, author_user_id, author_persona_id,
             post_type, status, visibility, body, created_at, updated_at)
           VALUES (
             'collision', $1, 'usr_author',
             (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
             'text', 'published', 'public', $1, $2, $2
           )`,
          [`post_${index.toString().padStart(2, "0")}`, created],
        );
      }
      await admin.query(
        `INSERT INTO posts
          (community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility, body, created_at, updated_at)
         VALUES
          ('collision', 'post_image', 'usr_author',
           (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
           'image', 'published', 'public', 'image', $1, $1),
          ('collision', 'post_members', 'usr_author',
           (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
           'text', 'published', 'members_only', 'members', $1, $1),
          ('collision', 'post_processing', 'usr_author',
           (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
           'text', 'processing', 'public', 'processing', $1, $1),
          ('community-other', 'post_other', 'usr_other',
           (SELECT persona_id FROM personas WHERE account_id='usr_other' AND is_first_persona),
           'text', 'published', 'public', 'other', $1, $1)`,
        [base],
      );

      const repository = makeControlPlanePublicCommunityThreadsRepository({
        now: () => base.getTime(),
      });
      const exact = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request("collision"))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      expect(exact.community.id).toBe("collision");
      expect(exact.community.route_slug).toBe("exact-community");
      expect(exact.items).toHaveLength(20);
      expect(exact.items.every((item) => item.post.post_type === "text")).toBe(true);
      expect(exact.items.some((item) => item.post.id === "post_members")).toBe(false);
      expect(exact.items.some((item) => item.post.id === "post_processing")).toBe(false);
      expect(exact.items[0]?.post.id).toBe("post_00");

      const underscoreId = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request("community_1"))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      expect(underscoreId.community.id).toBe("community_1");

      const second = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(
                request("collision", { cursor: exact.next_cursor ?? undefined }),
              )
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      const ids = [...exact.items, ...second.items].map((item) => item.post.id);
      expect(second.items.map((item) => item.post.id)).toEqual(["post_20", "post_21"]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(second.next_cursor).toBeNull();

      const slug = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request("current-community"))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      expect(slug.community.id).toBe("community-current");
      expect(slug.items).toEqual([]);

      const inactive = await Effect.runPromise(
        Effect.scoped(
          repository
            .listPublicCommunityThreads(request("hidden-community"))
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      );
      expect(inactive).toBeNull();
      const unknown = await Effect.runPromise(
        Effect.scoped(
          repository
            .listPublicCommunityThreads(request("missing-community"))
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      );
      expect(unknown).toBeNull();
    });
    completedTestCount += 1;
  });

  test("rejects malformed and cross-community cursors and preserves tenant scope", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      const now = new Date("2026-08-17T12:00:00.000Z");
      await admin.query("INSERT INTO users (user_id) VALUES ('usr_a'), ('usr_b')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        `INSERT INTO communities
          (community_id, route_slug, display_name, created_by_user_id, created_at, updated_at)
         VALUES ('community-a', 'alpha', 'Alpha', 'usr_a', $1, $1),
                ('community-b', 'beta', 'Beta', 'usr_b', $1, $1)`,
        [now],
      );
      for (let index = 0; index < 21; index += 1) {
        const created = new Date(now.getTime() - index * 1_000);
        await admin.query(
          `INSERT INTO posts
            (community_id, post_id, author_user_id, author_persona_id,
             post_type, status, visibility, body, created_at, updated_at)
           VALUES (
             'community-a', $1, 'usr_a',
             (SELECT persona_id FROM personas WHERE account_id='usr_a' AND is_first_persona),
             'text', 'published', 'public', $1, $2, $2
           )`,
          [`post_a_${index}`, created],
        );
      }
      await admin.query(
        `INSERT INTO posts
          (community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility, body, created_at, updated_at)
         VALUES (
           'community-b', 'post_b', 'usr_b',
           (SELECT persona_id FROM personas WHERE account_id='usr_b' AND is_first_persona),
           'text', 'published', 'public', 'b', $1, $1
         )`,
        [now],
      );
      const repository = makeControlPlanePublicCommunityThreadsRepository({
        now: () => now.getTime(),
      });
      const first = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request("alpha"))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      const firstCursor = first.next_cursor;
      if (firstCursor === null) throw new Error("cursor missing");
      expect(first.next_cursor).not.toBeNull();
      const malformed = await Effect.runPromiseExit(
        Effect.scoped(
          repository
            .listPublicCommunityThreads(request("alpha", { cursor: "pct1.not-base64" }))
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      );
      expect(String(malformed)).toContain("PublicCommunityThreadsRepositoryError");
      const crossCommunity = await Effect.runPromiseExit(
        Effect.scoped(
          repository
            .listPublicCommunityThreads(request("beta", { cursor: firstCursor }))
            .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
        ),
      );
      expect(String(crossCommunity)).toContain("PublicCommunityThreadsRepositoryError");
      const beta = requireDocument(
        await Effect.runPromise(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request("beta"))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        ),
      );
      expect(beta.items.map((item) => item.post.id)).toEqual(["post_b"]);
    });
    completedTestCount += 1;
  });

  test("fails closed on malformed non-null projected text scalars", async () => {
    await withSchema(async (connection, admin) => {
      await apply(connection);
      const now = new Date("2026-08-17T12:00:00.000Z");
      await admin.query("INSERT INTO users (user_id) VALUES ('usr_author')");
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        `INSERT INTO communities
          (community_id, route_slug, display_name, created_by_user_id, created_at, updated_at)
         VALUES ('community-malformed-body', 'malformed-body', 'Malformed body', 'usr_author', $1, $1),
                ('community-malformed-title', 'malformed-title', 'Malformed title', 'usr_author', $1, $1)`,
        [now],
      );
      await admin.query(
        `INSERT INTO posts
          (community_id, post_id, author_user_id, author_persona_id,
           post_type, status, visibility, body, title, created_at, updated_at)
         VALUES
          ('community-malformed-body', 'post-malformed-body', 'usr_author',
           (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
           'text', 'published', 'public', $2, NULL, $1, $1),
          ('community-malformed-title', 'post-malformed-title', 'usr_author',
           (SELECT persona_id FROM personas WHERE account_id='usr_author' AND is_first_persona),
           'text', 'published', 'public', 'body', $3, $1, $1)`,
        [now, " body ", " title "],
      );
      const repository = makeControlPlanePublicCommunityThreadsRepository({
        now: () => now.getTime(),
      });
      for (const slug of ["malformed-body", "malformed-title"]) {
        const result = await Effect.runPromiseExit(
          Effect.scoped(
            repository
              .listPublicCommunityThreads(request(slug))
              .pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection))),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const failure = Cause.findError(result.cause);
          expect(Result.isSuccess(failure) ? failure.success : undefined).toEqual(
            new PublicCommunityThreadsRepositoryError({
              operation: "list-public-community-threads",
              reason: "invalid-row",
            }),
          );
        }
      }
    });
    completedTestCount += 1;
  });

  afterAll(async () => {
    if (connectionString !== undefined && completedTestCount === 3) {
      await Bun.write(sentinelPath, sentinelContents);
    }
  });
});
