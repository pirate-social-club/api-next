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

Retention is fixed to `not_stored`. No persisted attempt or HTTP contract in
this tranche contains a PCM payload, transcript payload, or recognized-word
persistence field. The ephemeral WebSocket transcript/word events remain in
the protocol because they are part of the runtime source contract. Binary audio
is an out-of-band WebSocket frame; only its validated header metadata belongs
to the api-next contract boundary.
