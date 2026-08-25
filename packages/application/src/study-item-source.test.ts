import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { StudyItemSource, StudyItemSourceError } from "./ports.ts";
import {
  StudyItemSourceSetV1,
  studyItemSourceIdentityV1,
  studyItemSourcePromptV1,
} from "./study-item-source.ts";

const decodeSource = Schema.decodeUnknownSync(StudyItemSourceSetV1);
const encodeSource = Schema.encodeSync(StudyItemSourceSetV1);

const validSource = {
  version: "study_item_source_v1",
  song_revision: {
    community_id: "community_1",
    post_id: "post_1",
    audio_revision: 3,
    lyrics_revision: 2,
  },
  source_revision: 4,
  provenance: {
    kind: "accepted_song_lyrics",
    producer_id: "study-producer",
    producer_revision: "prompt-policy-v2",
  },
  items: [
    {
      source_item_key: "line-1-repeat",
      prompt: { kind: "text_response", text: "Sing the first line back." },
      answer_key: {
        kind: "text_response",
        comparison: "unicode_casefold_whitespace_v1",
        accepted_answers: ["Sail away with me tonight"],
      },
    },
    {
      source_item_key: "line-2-translation",
      prompt: {
        kind: "single_select",
        text: "Which translation matches the second line?",
        choices: [
          { choice_key: "choice-a", text: "Under a paper moon" },
          { choice_key: "choice-b", text: "Across a silver sea" },
        ],
      },
      answer_key: { kind: "single_select", correct_choice_key: "choice-a" },
    },
  ],
} as const;

describe("Study item source contract", () => {
  test("round-trips a nonempty typed source set", () => {
    const decoded = decodeSource(validSource);
    expect(encodeSource(decoded)).toEqual(validSource);
  });

  test("derives stable identity from immutable song and source revisions", () => {
    const source = decodeSource(validSource);
    const item = source.items[0];
    if (!item) throw new Error("expected a source item");

    expect(studyItemSourceIdentityV1(source, item)).toEqual({
      community_id: "community_1",
      post_id: "post_1",
      audio_revision: 3,
      lyrics_revision: 2,
      source_revision: 4,
      source_item_key: "line-1-repeat",
    });
    expect(studyItemSourceIdentityV1(source, item)).toEqual(
      studyItemSourceIdentityV1(source, item),
    );
  });

  test("projects prompt data without answer keys or private identity", () => {
    const source = decodeSource(validSource);
    const item = source.items[1];
    if (!item) throw new Error("expected a source item");

    const projection = studyItemSourcePromptV1(source, item);
    expect(projection).toEqual({
      version: "study_item_source_prompt_v1",
      identity: {
        community_id: "community_1",
        post_id: "post_1",
        audio_revision: 3,
        lyrics_revision: 2,
        source_revision: 4,
        source_item_key: "line-2-translation",
      },
      prompt: item.prompt,
    });
    expect(JSON.stringify(projection)).not.toContain("answer_key");
    expect(JSON.stringify(projection)).not.toContain("account_id");
    expect(JSON.stringify(projection)).not.toContain("persona_id");
  });

  test("rejects empty sets, duplicate identities, and invalid grading bindings", () => {
    expect(() => decodeSource({ ...validSource, items: [] })).toThrow();
    expect(() =>
      decodeSource({ ...validSource, items: [validSource.items[0], validSource.items[0]] }),
    ).toThrow();
    expect(() =>
      decodeSource({
        ...validSource,
        items: [
          {
            ...validSource.items[0],
            answer_key: { kind: "single_select", correct_choice_key: "choice-a" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeSource({
        ...validSource,
        items: [
          {
            ...validSource.items[1],
            answer_key: { kind: "single_select", correct_choice_key: "missing" },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("StudyItemSource port", () => {
  test("resolves only the exact accepted song revision", async () => {
    const source = decodeSource(validSource);
    const calls: unknown[] = [];
    const service: StudyItemSource["Service"] = {
      getForAcceptedSongRevision: (input) => {
        calls.push(input);
        return Effect.succeed(source);
      },
    };
    const input = {
      communityId: "community_1",
      postId: "post_1",
      audioRevision: 3,
      lyricsRevision: 2,
    };
    const program = Effect.gen(function* () {
      const itemSource = yield* StudyItemSource;
      return yield* itemSource.getForAcceptedSongRevision(input);
    });

    await expect(
      Effect.runPromise(Effect.provideService(program, StudyItemSource, service)),
    ).resolves.toEqual(source);
    expect(calls).toEqual([input]);
  });

  test("uses a closed source failure without provider or storage details", () => {
    const error = new StudyItemSourceError({ reason: "invalid-source" });
    expect(error).toMatchObject({ _tag: "StudyItemSourceError", reason: "invalid-source" });
    expect(Object.keys(error)).not.toContain("cause");
    expect(Object.keys(error)).not.toContain("provider");
    expect(Object.keys(error)).not.toContain("sql");
  });
});
