# Study v2 adoption matrix

This record closes the adoption-or-supersession decision required by Study
specification 018 §11. Study v2 is the sole runtime authority for new Study
sessions. Historical shapes remain readable only where migration or audit
evidence requires them.

The wired v1 runtime contract (`text_response` and `single_select`) is
superseded. Its response mechanics survive as dimensions inside Study v2, but
its positional source keys and set-level cloze producer do not define identity,
generation quality, or new session behavior.

The dormant community-shard song tables are superseded. Their
`say_it_back`, `translation_choice`, and `fill_blank` vocabulary is not a wire
authority. No runtime repository reads or writes those tables. The reserved
token-placement cloze is not enabled in v2.

The generic learning-card and review bridge is superseded for Study storage.
Study v2 uses `study_exercise_versions`, account-scoped `study_review_items`,
and immutable session snapshots. Generic FSRS concepts may inform a later
scheduler, but the dormant bridge is not runtime authority.

The Solid fixture model is superseded as a wire contract. Its user experience
is useful implementation evidence, while generated v2 contracts govern API
payloads, answer secrecy, transcript evidence, feedback, and identity.

The opaque `study_capability` post field is retired. Clients must use the typed
Study v2 availability endpoint and its explicit unavailable, processing,
policy-blocked, and ready states.
