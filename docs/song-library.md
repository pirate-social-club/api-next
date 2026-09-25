# Persona activity song library

GET /personas/:personaId/songs is an account-private read. The authenticated
subject must own an active persona. Missing, foreign and inactive personas all
return NotFound. The transport marks persona reads private and no-store.

The collection derives from study_sessions, study_sessions_v2, karaoke_sessions
and dance_sessions. A durable session start adds the song; page views and
purchases do not. The read includes unfinished sessions and collapses repeated
activities to one row per community and song. Session creation/completion and
current study presentation times determine recency. Activity labels describe
participation, not completion or qualification.

Rows use current published song metadata. Inactive communities, removed songs,
ratings the account cannot access, and members-only songs without current
membership are excluded. Pagination returns 25 songs with a persona-bound
cursor and a stable timestamp/community/post ordering; timestamps preserve
PostgreSQL microseconds. Concurrent new activity can move songs ahead of a
cursor, so refresh the first page to see those updates.

GET /songs/trending is independent public discovery. It ranks current public,
general-rated songs by distinct active accounts that started study, karaoke or
dance sessions during the last seven days. At least three accounts are required.
Repeated starts and multiple personas belonging to the same account count once.
Ties use latest start, community and post. Only the top twelve song projections
are returned; participant identities, private histories and counts are absent.

No activity writer, qualification, purchase, reward or persona authority is
changed. The existing activity routes still perform their own readiness and
participation checks. Dance history appears in the Solid library; a Dance
launch action waits for an owned standalone Dance screen.

The PostgreSQL query test uses isolated production-shaped read tables and
explicit access-function fixtures. It tests the read SQL, not the activity
writers' lifecycle constraints; those retain their own PostgreSQL suites.
