import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  IdentityResolutionError,
  type IdentityStore,
  type PublicProfileLookup,
  PublicProfileRepositoryError,
} from "@pirate/application";
import { Effect } from "effect";
import { makeControlPlanePublicProfileRepository } from "./public-profile-repository.ts";

const active = (overrides: Record<string, unknown> = {}) => ({
  handle_id: "handle_new",
  label_normalized: "captainpublic",
  label_display: "captainpublic.pirate",
  status: "active",
  owner_user_id: "usr_source",
  redirect_target_handle_id: null,
  ...overrides,
});

function fakeDb(input: {
  readonly requested: Record<string, unknown>[];
  readonly target?: Record<string, unknown>[];
  readonly communities?: Record<string, unknown>[];
}) {
  const statements: string[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = <Row = unknown>(
    statement: ControlPlaneStatement,
  ) => {
    statements.push(statement.text);
    const rows =
      statement.label === "public-profiles.handles.lookup"
        ? input.requested
        : statement.label === "public-profiles.handles.redirect-target"
          ? (input.target ?? [])
          : (input.communities ?? [
              {
                community_id: "community-beta",
                display_name: "Beta Club",
                created_at: "2026-04-18T00:00:00.000Z",
                route_slug: null,
              },
            ]);
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  };
  const db: ControlPlaneDb["Service"] = {
    execute,
    withTransaction: (use) => use({ execute }),
  };
  return { db, statements };
}

function identityStore(
  resolve: IdentityStore["Service"]["resolveCanonical"] = ({ sourceUserId }) =>
    Effect.succeed({
      sourceUserId,
      canonicalUserId: "usr_canonical",
      aliasPath: sourceUserId === "usr_canonical" ? [] : [sourceUserId],
    }),
): IdentityStore["Service"] {
  return {
    findUser: (userId) =>
      Effect.succeed(userId === "usr_canonical" ? { userId, account: { persisted: true } } : null),
    resolveCanonical: resolve,
  };
}

function runLookup(
  input: Parameters<ReturnType<typeof makeControlPlanePublicProfileRepository>["getByHandle"]>[0],
  rows: Parameters<typeof fakeDb>[0],
  store = identityStore(),
) {
  const fake = fakeDb(rows);
  const repository = makeControlPlanePublicProfileRepository(store);
  return {
    result: Effect.runPromiseExit(
      repository.getByHandle(input).pipe(Effect.provideService(ControlPlaneDb, fake.db)),
    ),
    statements: fake.statements,
  };
}

describe("public profile handle index repository", () => {
  test("does an exact indexed normalized lookup and real creator-community query", async () => {
    const output = runLookup({ labelNormalized: "captainpublic" }, { requested: [active()] });
    const result = await output.result;
    expect(result).toMatchObject({ _tag: "Success" });
    if (result._tag !== "Success") return;
    const value = result.value as PublicProfileLookup;
    expect(value).toMatchObject({
      canonicalUserId: "usr_canonical",
      handleId: "handle_new",
      handleLabelNormalized: "captainpublic",
      handleStatus: "active",
      createdCommunities: [{ community: "community-beta", route_slug: null }],
    });
    expect(output.statements[0]).toContain("WHERE label_normalized = $1");
    expect(output.statements[0]).toContain("FROM public_handle_index");
    expect(output.statements[1]).toContain("created_by_user_id = $1");
    expect(output.statements[1]).toContain("ORDER BY created_at DESC");
    expect(output.statements.join("\n")).not.toContain("jsonb");
  });

  test("resolves one valid redirect and fails closed for a missing target", async () => {
    const redirected = runLookup(
      { labelNormalized: "oldcaptain" },
      {
        requested: [
          active({
            handle_id: "handle_old",
            label_normalized: "oldcaptain",
            label_display: "oldcaptain.pirate",
            status: "redirect",
            redirect_target_handle_id: "handle_new",
          }),
        ],
        target: [active()],
      },
    );
    const redirectResult = await redirected.result;
    expect(redirectResult).toMatchObject({ _tag: "Success", value: { handleStatus: "redirect" } });

    const missing = runLookup(
      { labelNormalized: "oldcaptain" },
      {
        requested: [
          active({
            handle_id: "handle_old",
            label_normalized: "oldcaptain",
            label_display: "oldcaptain.pirate",
            status: "redirect",
            redirect_target_handle_id: "handle_missing",
          }),
        ],
      },
    );
    expect(await missing.result).toMatchObject({ _tag: "Success", value: null });
  });

  test("maps alias cycles to a typed invalid-alias failure and retires stay hidden", async () => {
    const cyclic = runLookup(
      { labelNormalized: "captainpublic" },
      { requested: [active()] },
      identityStore(() => Effect.fail(new IdentityResolutionError({ reason: "cyclic" }))),
    );
    const cycleResult = await cyclic.result;
    expect(cycleResult).toMatchObject({ _tag: "Failure" });
    const retired = runLookup(
      { labelNormalized: "retired" },
      {
        requested: [
          active({
            status: "retired",
            label_normalized: "retired",
            label_display: "retired.pirate",
          }),
        ],
      },
    );
    expect(await retired.result).toMatchObject({ _tag: "Success", value: null });
    expect(PublicProfileRepositoryError).toBeDefined();
  });
});
