# PlanetScale support request draft

Not sent. The workspace has an authenticated metadata CLI but no configured
support-ticket or email transport. This draft contains no credentials or user
data. Filing it is authorized; successful delivery and a ticket identifier must
be recorded before calling it filed.

Subject: PostgreSQL staging lock-table configuration and supported limits

We are rehearsing a reset of a disposable PostgreSQL 17 staging database under
a maintained application fence. Its last verified settings were
max_locks_per_transaction=64, max_connections=25 and max_prepared_transactions=0.
The database is pirate-staging, branch main. Production is not in scope.

Can max_locks_per_transaction be configured on this staging cluster through
support or a searchable parameter? If so, what values, memory impact and restart
procedure are supported? The public parameter reference lists commonly displayed
settings, so we have not assumed that omission proves a parameter unavailable.

If max_connections is the appropriate supported lever instead, what range is
available on this cluster size, what memory/reserved-connection effects should
we account for, and would a temporary increase require a paid resize?

Our local rehearsal observed high lock demand for bulk catalogue removal. We
are implementing bounded committed phases with restore-from-capture recovery,
so this question does not request a live parameter change or a bypass of normal
limits. Please confirm the supported options and their operational requirements.
