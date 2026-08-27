# Raw MP3 ACR sampling evidence

The redacted [staging proof](./staging-2026-08-27.json) records both closed
outcomes required for the no-cost public-song v1 path. The exact
production-generated primary frame window matches the project-owned fixture
retained in the custom bucket, while a deterministic fixture generated from a
different seed returns no match and remains eligible for the publication
happy path.

The evidence contains no credential, provider resource identifier, URL,
header, request or response body, provider match identifier, or media bytes.
The permanent positive fixture is synthetic and project-owned. Its retention
is limited to the staging custom bucket so later adapter changes can repeat a
true-positive regression proof without another manual upload and indexing
cycle.
