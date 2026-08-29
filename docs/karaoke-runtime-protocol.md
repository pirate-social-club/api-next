# Karaoke runtime protocol handoff

The protocol boundary ported into api-next is defined in
`packages/contracts/src/karaoke.ts`. It preserves the runtime's protocol
version, JSON event unions, binary-frame header constants, sequence identity,
server event shapes, score breakdown, and provenance shape.

The historical runtime specification referred to
`web/docs/karaoke-audio-capture.md`, but that file does not exist. The
browser-specific capture lifecycle is deliberately owned by the standalone
`pirate-web-solid` application and is not part of this api-next contract
tranche. The capture implementation and its lifecycle tests are Step 2 work;
this document therefore has no dependency on the dead legacy path.

Spec 019 supersedes the original retention note. Provider retention remains
`not_stored`, while the exact server-accepted PCM is archived privately for the
learner under `platform_retention: private_learning`. Archive reconciliation is
independent from scoring and qualification. No transcript, partial provider
payload, recognized text, voiceprint, or speaker identity is retained. The
ephemeral WebSocket transcript and word events remain available during the
session, while persisted diagnostics reference only expected lyric-word
positions. Binary audio remains an out-of-band WebSocket frame.
