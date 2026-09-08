# Testnet reward sponsorship backend

This release adds the missing policy and admitted-asset reads to the existing
song reward creation and funding APIs. It does not enable production rewards,
add Dance or NFT prizes, or establish browser funding acceptance.

## Discovery and review

GET /rewards/qualification-policies requires authentication and returns the
current complete policy for Study and Karaoke. Study requires 7000 bps correct.
Karaoke requires 8500 bps coverage, 7000 bps final score and five scored lines;
its version-specific playback restrictions are also returned. Render these
requirements read-only. They are not a sponsor policy picker.

GET /rewards/bonus-assets requires authentication and returns exact active
bonus-asset metadata for the server-configured testnet attestation and environment.
The optional limit is 1 through 50, defaulting to 25. Continue with next_cursor
until it is null. An empty page means no assets match; unavailable authority or
storage returns ProviderUnavailable, not an empty success. Both reads use
Cache-Control: no-store and create no money effects. The client methods are
get_rewardsQualificationPolicies and get_rewardsBonusAssets; the friendly
operation names are generated Input, Response and Error aliases.

## Creation and recovery

OpenSongRewardOffer and the two AddLeg operations retain their existing
idempotency boundaries. Persist the original key and exact request before a
create request is sent. Replay that request after an interrupted response;
never generate a replacement key merely because the response was lost. Persist
the returned leg and funding-effect identities before wallet signing. Creating
a leg does not sign or broadcast a transfer.

An optional expected_qualification_policy_versions map asserts the versions
shown during review. It must name exactly the leg's applicable activities and
match their current server versions. A stale assertion returns Conflict before
creation. A successful replay returns the original leg even if current policies
have since changed. If the assertion is omitted, review the actual policies
returned by creation before authorizing the transfer.

New legs contain qualification_policies frozen by a database insert trigger.
Their leg_terms_hash commits to the original terms hash and these policies.
Admission requires the qualification's activity and policy version to match
that binding. Legacy legs return qualification_policies: null, keep their
original hashes, and retain legacy admission. Never label a legacy leg with the
current preview as though those requirements were its committed terms.

Megapot eligible_activities remains an explicit non-empty distinct list of
Study and/or Karaoke. Its additional min_score_bps remains adjustable from 7000
to 10000 on ordinary pools, and exactly 7000 for funder_fallback. Each activity's
own gates still apply. Asset bonuses have no activity selector or score floor.
Token admission is rechecked during creation, so retiring a previously listed
asset rejects a new leg without invalidating an existing idempotent replay.

After an explicitly approved wallet transfer, use the existing ObserveFunding
operation with the hash and read funding status until the server establishes the
outcome. A hash alone is not confirmation. Top-up, pause, cancellation and refund
history are not added by this release. Browser pre-create persistence, wallet
review and recovery-state presentation remain owned by the Solid sponsor task.

## Client adoption

Adopt the 0.68.0 archive before consuming the changed leg-creation and song
reward projection responses. Older generated clients validate closed response
objects and can reject the new qualification_policies field. Existing request
bodies remain accepted when the optional preview assertion is absent; the
funding observation and funding-effect response shapes remain unchanged.
The additive OpenAPI check does not establish compatibility with an older
client's closed response validator. Apply migration 0134 before the updated HTTP and jobs Workers use this schema.
Coordinate client adoption with staging integration; no existing archive is
rewritten. A local release candidate does not authorize that rollout or a
funded ceremony.
