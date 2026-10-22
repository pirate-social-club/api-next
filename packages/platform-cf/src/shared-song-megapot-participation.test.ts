import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { TermsV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import { sharedSongParticipantFixture } from "../../testing/src/shared-song-participant-fixture.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
  type PostgresQueryResponse,
} from "./postgres.ts";
import {
  decodeSharedSongParticipation,
  makeSharedSongMegapotParticipationReader,
} from "./shared-song-megapot-participation.ts";

const decode = (value: unknown, community = "test-community", post = "test-song") =>
  Effect.runPromise(decodeSharedSongParticipation(value, community, post));
function at<A>(values: readonly A[], index: number): A {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}

class ReadDriver implements PostgresClientLike {
  readonly queries: PostgresQueryConfig[] = [];
  ended = false;
  constructor(
    readonly packet: unknown,
    readonly loseCommit = false,
  ) {}
  connect() {
    return Promise.resolve();
  }
  async query(query: PostgresQueryConfig): Promise<PostgresQueryResponse> {
    this.queries.push(query);
    if (query.text === "COMMIT" && this.loseCommit) throw new Error("lost read acknowledgement");
    return query.text.includes("read_shared_song_megapot_participation_v2")
      ? { rows: [{ packet: this.packet }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  end() {
    this.ended = true;
    return Promise.resolve();
  }
}

describe("shared participant frozen-policy decoder", () => {
  test("checks actual terms/binding/document hashes and emits only allowlisted disclosures", async () => {
    const packet = await sharedSongParticipantFixture();
    const result = await decode(packet);
    if (result.status !== "found" || result.participation === null)
      throw new Error("Expected fictional shared pot");
    expect(result.participation.qualification_rules.map((rule) => rule.binding.activity)).toEqual([
      "study",
      "karaoke",
      "dance",
    ]);
    const dance = at(result.participation.qualification_rules, 2);
    expect(dance.binding.numeric_floor_bps).toBeNull();
    expect(dance.rule).toEqual({
      kind: "dance_owner_verdict_v1",
      qualification_policy_version_id: "test-policy-dance",
      grading_mode: "moderator_verdict",
      verdict: "passed",
    });
    const wire = JSON.stringify(result.participation);
    expect(wire).not.toContain("test-producer");
    expect(wire).not.toContain('"document"');
    expect(wire).not.toContain('"policy_hash"');
  });
  test("does not replace frozen rules when current admission is unavailable", async () => {
    const packet = await sharedSongParticipantFixture();
    at(packet.qualification_documents, 2).currently_available = false;
    const result = await decode(packet);
    if (result.status !== "found" || result.participation === null) throw new Error("Expected pot");
    expect(at(result.participation.qualification_rules, 2).currently_available).toBe(false);
    expect(result.participation.terms).toEqual(
      Schema.decodeUnknownSync(TermsV2)(packet.projection.terms),
    );
  });
  test("distinguishes an accessible song without a pot from unavailable content", async () => {
    expect(await decode(null)).toEqual({ status: "found", participation: null });
    expect(await decode({ status: "not_found" })).toEqual({ status: "not_found" });
  });
  test.each(["community", "song"])("rejects a foreign %s packet", async (kind) => {
    const packet = await sharedSongParticipantFixture();
    await expect(
      decode(
        packet,
        kind === "community" ? "foreign" : "test-community",
        kind === "song" ? "foreign" : "test-song",
      ),
    ).rejects.toThrow();
  });
  test.each(["terms", "binding", "document", "embedded", "identity", "duplicate"])(
    "rejects corrupt %s provenance before disclosure",
    async (kind) => {
      const packet = await sharedSongParticipantFixture();
      if (kind === "terms") packet.projection.terms.ends_at = "2026-10-26T17:00:00.000Z";
      if (kind === "binding")
        at(packet.projection.terms.qualification_bindings, 0).numeric_floor_bps = 9000;
      if (kind === "document")
        at(packet.qualification_documents, 0).document.required_correct_bps = 8000;
      if (kind === "embedded")
        at(packet.qualification_documents, 2).document.policy_hash = "b".repeat(64);
      if (kind === "identity") at(packet.qualification_documents, 0).policy_id = "foreign-policy";
      if (kind === "duplicate")
        packet.qualification_documents[1] = at(packet.qualification_documents, 0);
      await expect(decode(packet)).rejects.toThrow();
    },
  );
  test("does not accept raw review policy/rubric fields or choose a common rubric", async () => {
    const packet = await sharedSongParticipantFixture();
    Object.assign(at(packet.qualification_documents, 2), {
      review_policies: [{ rubric_hash: "a".repeat(64) }, { rubric_hash: "b".repeat(64) }],
    });
    await expect(decode(packet)).rejects.toThrow();
  });
});

describe("shared participant maintained Postgres read boundary (offline driver)", () => {
  test("issues one account-scoped read and releases the actual connection", async () => {
    const driver = new ReadDriver(await sharedSongParticipantFixture());
    const reader = makeSharedSongMegapotParticipationReader(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
        logger: { info: () => undefined, error: () => undefined },
      }),
    );
    expect((await reader("account", "test-community", "test-song")).status).toBe("found");
    const reads = driver.queries.filter((q) =>
      q.text.includes("read_shared_song_megapot_participation_v2"),
    );
    expect(reads).toHaveLength(1);
    expect(at(reads, 0).values).toEqual(["account", "test-community", "test-song"]);
    expect(
      driver.queries.some((q) =>
        /^(INSERT|UPDATE|DELETE|GRANT|CREATE|SELECT pg_advisory)/u.test(q.text),
      ),
    ).toBe(false);
    expect(driver.ended).toBe(true);
  });
  test("does not retry a read after an uncertain outer commit acknowledgement", async () => {
    const driver = new ReadDriver(await sharedSongParticipantFixture(), true);
    const reader = makeSharedSongMegapotParticipationReader(
      makeDirectPostgresControlPlaneLayer("postgres://offline.invalid/unused", {
        clientFactory: () => driver,
        logger: { info: () => undefined, error: () => undefined },
      }),
    );
    await expect(reader("account", "test-community", "test-song")).rejects.toThrow();
    expect(
      driver.queries.filter((q) => q.text.includes("read_shared_song_megapot_participation_v2")),
    ).toHaveLength(1);
    expect(driver.ended).toBe(true);
  });
});
