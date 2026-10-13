import { describe, expect, test } from "bun:test";
import {
  ControlPlaneDb,
  type ControlPlaneStatement,
  ControlPlaneStatementFailed,
  type PreparedGuestStudyContentStore,
} from "@pirate/application";
import { GuestStudyPreparedContentV1, type StudyLearnerBandV2 } from "@pirate/contracts";
import { Effect, Layer, Schema } from "effect";
import {
  makeControlPlanePreparedGuestStudyContentStore,
  projectPreparedGuestStudyContent,
} from "./guest-prepared-study-content-store.ts";

const input: Parameters<PreparedGuestStudyContentStore["get"]>[0] = {
  communityId: "public-community",
  postId: "public-song",
  targetLanguage: null,
  learnerBand: null,
};
const disclosure = {
  version: "fixture-disclosure-v1",
  text: "Synthetic fixture disclosure; supplied policy is required.",
};
const source = (count: number) => ({
  exercise_type: "say_it_back",
  learning_language: "en",
  target_language: null,
  learner_band: null,
  count,
});
const translated = (target_language: string, learner_band: StudyLearnerBandV2, count: number) => ({
  exercise_type: "translation_choice",
  learning_language: "en",
  target_language,
  learner_band,
  count,
});
const project = (rows: unknown, selection = input) =>
  projectPreparedGuestStudyContent(selection, disclosure, rows);

describe("public prepared guest Study projection", () => {
  test("a prepared source-only lesson matches the frozen response and creates no reward preview", () => {
    const result = project([source(4)]);
    expect(result).toEqual({
      object: "guest_study_prepared_content_v1",
      availability: {
        state: "ready",
        available_exercise_types: ["say_it_back"],
        learning_language: "en",
        target_languages: [],
        learner_bands: [],
      },
      disclosure,
      reward_preview: null,
    });
    expect(Schema.decodeUnknownSync(GuestStudyPreparedContentV1)(result)).toEqual(result);
  });
  test("four genuinely compatible cards suffice; helper/band selection excludes other combinations", () => {
    const rows = [source(2), translated("ar", "B1", 2), translated("zh", "A1", 1)];
    expect(project(rows).availability.state).toBe("ready");
    expect(
      project(rows, { ...input, targetLanguage: "ar", learnerBand: "B1" }).availability.state,
    ).toBe("ready");
    expect(
      project(rows, { ...input, targetLanguage: "zh", learnerBand: "A1" }).availability.state,
    ).toBe("processing");
  });
  test("different helper languages or bands never sum into a fabricated four-card lesson", () => {
    expect(project([translated("ar", "A1", 2), translated("zh", "A1", 2)]).availability.state).toBe(
      "processing",
    );
    expect(project([translated("ar", "A1", 2), translated("ar", "B1", 2)]).availability.state).toBe(
      "processing",
    );
  });
  test("a band-only query discovers compatible helpers independently of the omitted language filter", () => {
    const rows = [translated("ar", "B1", 4), translated("zh", "A1", 4)];
    expect(project(rows, { ...input, learnerBand: "B1" }).availability.state).toBe("ready");
    expect(project(rows, { ...input, learnerBand: "C2" }).availability.state).toBe("unavailable");
    expect(
      project(rows, { ...input, targetLanguage: "zh", learnerBand: "B1" }).availability.state,
    ).toBe("unavailable");
  });
  test("no prepared cards is unavailable; a partial preparation does not invent pending generation", () => {
    expect(project([]).availability).toEqual({
      state: "unavailable",
      reason: "insufficient_exercises",
    });
    expect(project([source(3)]).availability).toEqual({
      state: "processing",
      available_exercise_types: ["say_it_back"],
      pending_exercise_types: [],
    });
  });
  test("128 canonical target languages are preserved; a 129th refuses even a narrow selected request", () => {
    const languages = [
      ...new Set(
        Array.from(
          { length: 256 },
          (_, i) => Intl.getCanonicalLocales(`fr-${String(i + 100).padStart(3, "0")}`)[0],
        ),
      ),
    ];
    const rows = languages.slice(0, 128).map((language) => translated(language as string, "A1", 1));
    const result = project([source(4), ...rows]);
    expect(result.availability.state).toBe("ready");
    if (result.availability.state !== "ready")
      throw new Error("expected bounded prepared readiness");
    expect(result.availability.target_languages).toHaveLength(128);
    expect(() =>
      project([source(4), ...rows, translated(languages[128] as string, "A1", 1)], {
        ...input,
        targetLanguage: "ar",
        learnerBand: "A1",
      }),
    ).toThrow();
  });
  test("64-character canonical languages are preserved, and longer tags are refused", () => {
    const language = "fr-Latn-US-variant1-variant2-variant3-variant4-variant5-variant6";
    expect(language.length).toBe(64);
    expect(project([source(4), translated(language, "A1", 1)]).availability.state).toBe("ready");
    expect(() => project([source(4), translated(`${language}-variant7`, "A1", 1)])).toThrow();
  });
  test("both exercise types and all six bands are retained; unexpected types or bands are refused", () => {
    const bands: readonly StudyLearnerBandV2[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
    const rows = bands.map((band) => translated("ar", band, 1));
    const result = project([source(4), ...rows]);
    if (result.availability.state !== "ready") throw new Error("expected prepared readiness");
    expect(result.availability.available_exercise_types).toHaveLength(2);
    expect(result.availability.learner_bands).toEqual(bands);
    expect(() => project([source(4), { ...source(1), exercise_type: "typed_cloze" }])).toThrow();
    expect(() =>
      project([source(4), ...rows, { ...translated("ar", "C2", 1), learner_band: "C3" }]),
    ).toThrow();
  });
});

const fixture = (
  overrides: Readonly<{
    accessible?: boolean;
    stems?: boolean;
    lyrics?: boolean;
    language?: boolean;
    rows?: readonly unknown[];
  }> = {},
) => {
  const calls: ControlPlaneStatement[] = [];
  const execute: ControlPlaneDb["Service"]["execute"] = (statement) => {
    calls.push(statement);
    if (statement.label !== "guest-study.prepared.snapshot")
      throw new Error("Unexpected non-readiness operation");
    const rows = [
      {
        accessible: overrides.accessible ?? true,
        source_rows: [
          {
            lyrics_ready: overrides.lyrics ?? true,
            language_ready: overrides.language ?? true,
            stems_ready: overrides.stems ?? true,
          },
        ],
        prepared_rows: overrides.rows ?? [source(4)],
      },
    ];
    return Effect.succeed({ rows, rowCount: rows.length }) as never;
  };
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  return {
    calls,
    runtime,
    store: makeControlPlanePreparedGuestStudyContentStore(runtime, disclosure),
  };
};

describe("public prepared content store boundary", () => {
  test("an inaccessible/non-public resource refuses prepared-data projection", async () => {
    const f = fixture({ accessible: false });
    const error = await Effect.runPromise(Effect.flip(f.store.get(input)));
    expect(error._tag).toBe("GuestParticipationStoreRejected");
    if (error._tag !== "GuestParticipationStoreRejected")
      throw new Error("expected closed store refusal");
    expect(error.reason).toBe("not-found");
    expect(f.calls).toHaveLength(1);
  });
  test("missing stems, unaccepted lyrics and unsupported language return truthful public unavailability", async () => {
    for (const [override, reason] of [
      [{ stems: false }, "stems_missing"],
      [{ lyrics: false }, "lyrics_not_accepted"],
      [{ language: false }, "learning_language_unsupported"],
    ] as const) {
      const f = fixture(override);
      expect((await Effect.runPromise(f.store.get(input))).availability).toEqual({
        state: "unavailable",
        reason,
      });
      expect(f.calls).toHaveLength(1);
    }
  });
  test("a public read uses only read statements and resource locators, without account or credential authority", async () => {
    const f = fixture();
    await Effect.runPromise(f.store.get(input));
    expect(f.calls).toHaveLength(1);
    for (const statement of f.calls) {
      expect(statement.readonly).toBe(true);
      expect(statement.values).toEqual([input.communityId, input.postId]);
    }
  });
  test("corrupt or oversized prepared rows are a closed failure, not unavailable or truncated success", async () => {
    const f = fixture({ rows: [{ ...source(4), target_language: "ar" }] });
    const error = await Effect.runPromise(Effect.flip(f.store.get(input)));
    expect(error._tag).toBe("GuestParticipationStoreRejected");
    if (error._tag !== "GuestParticipationStoreRejected")
      throw new Error("expected closed store refusal");
    expect(error.reason).toBe("resource-policy-unavailable");
  });
  test("missing disclosure policy is refused even for an unavailable source, before any read", async () => {
    const f = fixture({ stems: false });
    const store = makeControlPlanePreparedGuestStudyContentStore(f.runtime, {
      version: "",
      text: "",
    });
    const error = await Effect.runPromise(Effect.flip(store.get(input)));
    expect(error._tag).toBe("GuestParticipationStoreRejected");
    expect(f.calls).toHaveLength(0);
  });
  test("a bigint string or malformed count is refused rather than coerced or defaulted", async () => {
    const f = fixture({ rows: [{ ...source(4), count: "4" }] });
    const error = await Effect.runPromise(Effect.flip(f.store.get(input)));
    expect(error._tag).toBe("GuestParticipationStoreRejected");
  });
  test("database failures propagate as operational failure instead of being projected as ordinary unavailability", async () => {
    const failure = new ControlPlaneStatementFailed({
      label: "fixture",
      sqlState: "42501",
      constraint: null,
      outcomeCertainty: "aborted",
    });
    const execute: ControlPlaneDb["Service"]["execute"] = () => Effect.fail(failure);
    const runtime = Layer.succeed(ControlPlaneDb, {
      execute,
      withTransaction: (use) => use({ execute }),
    });
    const store = makeControlPlanePreparedGuestStudyContentStore(runtime, disclosure);
    expect(await Effect.runPromise(Effect.flip(store.get(input)))).toBe(failure);
  });
});
