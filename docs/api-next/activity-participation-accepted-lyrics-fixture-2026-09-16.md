# Accepted-lyrics activity fixture and provider requirements

Written 2026-09-16 for the activity participation preparation tranche. This is
a specification for a later local fixture; it makes no provider call, no
staging change and no scoring-policy change. Dance and shared draft surfaces
remain outside it.

## Why the M1 instrumental song is insufficient

M1 publishes an instrumental song and its Staging playback proof persists
`no_lyrics`. Study v2 selects exercises from an accepted lyrics revision, and
Karaoke reserves a session from a ready timed-lyrics alignment artifact. With
`no_lyrics` both producers fail before authority is even relevant:

- Study v2 `startSession` joins `study_exercise_versions` to the exact
  `media_post_submissions.current_lyrics_revision` and rejects with
  `insufficient-exercises` below four rows.
- Karaoke readiness joins `media_timed_lyrics_artifacts` to a `ready`
  `media_alignment_projections` row and the same publication lyrics revision.

The never-joined participation journey therefore needs a second, disposable
fixture song with accepted lyrics, not a modification of the M1 media.

## Required fixture rows (disposable schema only)

All rows below are local test data. They are inserted in fixtures, never on
Staging, and they do not require an external call.

| Surface | Required rows |
| --- | --- |
| Post and publication | `posts` row, `post_type='song'`, `status='published'`, `visibility='public'`, `content_rating='general'`; `media_post_submissions` with matching `audio_revision` and `current_lyrics_revision`; `media_publication_projections` with `lyrics_status='ready'`, the exact `lyrics_revision`, and the canonical lyrics text |
| Lyrics identity | `localization_lyric_line_occurrences`, `localization_lyric_line_versions`, `localization_study_units`, `localization_lyric_line_study_units`, and `localization_lyrics_revision_lines` for every line, with `source_hash` equal to the SHA-256 of the canonical line text |
| Study exercises | At least four `study_exercise_versions` rows, `exercise_type='say_it_back'`, `exercise_variant='spoken-recall-v2'`, `learner_band IS NULL`, `target_language IS NULL`, accepted validators (`study-source-structure-v1`, `study-source-semantic-v1`, `study-source-safety-v1`, `study-source-quality-v1`, `accepted-source-v1`), grader policy `script_aware_token_phonetic_v2`, feedback policy `spoken-feedback-v1`, and one distinct `exercise_review_key` per line |
| Karaoke alignment | `activity_registry` karaoke active at `karaoke_qualification_v2@1`; `media_alignment_projections` with `status='ready'`; `media_timed_lyrics_artifacts` with a word-mode `media-timed-lyrics-artifact-v1` payload whose segments cover the accepted lyric words |

The four-line fixture in `activity-participation-preparation.pg.test.ts` is the
reference shape. A later study-scoring fixture needs a longer accepted lyric
with enough distinct units for `all_resolved` completion and for at least one
review reappearance.

## Provider requirements (list only, no calls)

These are the provider capabilities the later scoring and playback acceptance
would exercise. They are listed for readiness planning; this tranche calls none
of them and adds no credential or budget.

1. Speech recognition and grading for Study spoken answers. The repository
   accepts a provider grade and detected language; a live scoring run needs the
   speech provider binding, request budget, and retention policy already
   defined for learner audio. The fixture itself uses a deterministic grade.
2. Karaoke alignment and scoring. A live run needs the configured scorer and
   the frozen qualification policy. The fixture uses a ready timed-lyrics
   artifact and a deterministic empty score, so it proves persistence and
   replay, not a qualifying score.
3. Lyrics acceptance and any generation pipeline used to produce exercises.
   The accepted-lyrics fixture is authored data; if a later run generates
   exercises instead, that generation must be a listed, budgeted call rather
   than an implicit fixture step.
4. Signed playback for the fixture song, reusing the existing playback secret
   bindings and Range proof. This is playback readiness, not a scoring call.

No ACRCloud, OpenAI, OpenRouter, ElevenLabs or chain call is part of this
fixture, and the fixture must remain runnable with provider flags off.

## Readiness checks a later run must assert

Study v2 `startSession` returns at least four items and completion resolves all
of them with `completion_reason='all_resolved'`; a reload keeps presentation
continuity; an exact reserve replay returns the first committed result. Karaoke
readiness reports ready and `reserveSession` returns timed lines with a stable
artifact revision; finalization persists one terminal attempt and replays it.
Neither command writes a Post, a follow, a membership, a wallet assignment, a
verification claim or a DATA operation.
