# Shared activity streak ranking population

Public song/community leaderboards and private progress standing use the same
`activity-streak-candidates-sql.ts` SELECT before computing competition rank.
A candidate has a live streak at the exact supplied observation time, an existing
presentation/profile, and accepted `active_activity_persona` authority: active
account, active community, active owned persona and its exact community binding.
Suspended personas and inactive accounts consume no rank positions.

Rank still orders current count descending, then best count descending. Equal
current/best scores share rank and leave competition gaps. Started day/persona ID
remain display-order tiebreakers. Public rank limits include all ties and retain
viewer standing outside the limit; anonymous reads have no viewer. Public scope,
handles, fields and privacy are unchanged. Private week/day/count facts retain
their separate authoritative reads and account timezone semantics. Expiration
is strictly `active_until_at > readAt`; one account's boundary does not define
another's after a prospective timezone change.

The existing two-case activity completion PG suite adds a comparison inside its
first case. All new streak days come from actual Karaoke reserve/finalize
producers. At one exact observation time, two tied eligible actors rank1 and the
existing viewer ranks3 despite higher suspended/inactive actors. Both scopes
compare private standing with public viewer standing, tie-inclusive limit1,
anonymous reads, public privacy, inactive refusal and exact expiration. Ledger,
decision and projection rows remain unchanged across reads. Bindings are
immutable, so an unbound-scope selection is rejected through the real admission
API instead of inventing an invalid historical ranking row. No new trigger
disable, grade/finance/streak policy, migration or public contract is introduced.

Declared test count remains2, completion sentinel still requires both cases,
and numeric cost estimates, timeouts and shard logic remain unchanged. Recorded
local measurements are source proof; parent full gates, CI, separate review and
runtime acceptance remain independent requirements.
