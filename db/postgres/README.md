# db/postgres

PlanetScale Postgres schema, forward-only migrations, and operational ledgers
for api-next (000 §4). Lane C owns this directory (001 §5). This is the sole
relational schema for every api-next environment; PostgreSQL dialect only.

Migrations are authoritative repository artifacts because PlanetScale Postgres
branches do not automatically merge schema changes. Apply them through the
forward-only ledger and expand/contract changes.

`schema.sql` is the cumulative baseline for the latest complete schema. The
numbered files are forward deltas and must be applied in order; at every
revision, applying all migrations to a fresh database must produce the same
catalog as applying `schema.sql` to a fresh database. They are not expected to
be byte-identical.

Workers connect with the least-privilege application role described in
`roles.sql.example`; the default administrative or `BYPASSRLS` role is not an
application credential. Application-scoped repository predicates are the
primary tenant boundary. RLS is intentionally deferred as optional
defense-in-depth until pooling and policy metrics justify it.
