# Postgres 17 test harness plan

The real-driver harness is a post-barrier test deliverable. This plan records
the local and CI contract without adding a dependency, changing `ci.yml`, or
adding a Postgres implementation in the preparation lane.

## Construction rules

Production tests use the same adapter constructor as the Worker, with a
Hyperdrive binding in production. Local and real-Postgres tests use an
explicit direct-URL test constructor. The URL is supplied by the test
environment and is never read as a production fallback.

The test database is PostgreSQL 17. The fixture creates a uniquely keyed probe
table or uses the registered control-plane test schema; each test uses a
random run id and cleans up only its own rows. All SQL is PostgreSQL-native,
uses `$1` parameters, and does not pass through a translation layer.

## Local run

With Docker available, start a disposable service container using the same
image and credentials as CI:

```bash
docker run --rm --name api-next-pg17 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres \
  -p 5432:5432 postgres:17
```

Some VPN/firewall setups block Docker bridge or published-port traffic. In
that environment the container can be healthy while connections to the
published port are reset and PostgreSQL logs no client connection. Use host
networking as a local harness workaround and omit `-p`:

```bash
docker run --rm --network host --name api-next-pg17 \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=postgres postgres:17
```

Keep the URL below pointed at `127.0.0.1:5432` and record the network mode in
the test evidence. This workaround changes only local harness connectivity;
it is not a staging or production topology recommendation.

Wait for `pg_isready` from the container, then run the future real-Postgres
test with an explicit URL such as:

```text
postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable
```

Local runs may use a normal test skip when no URL is configured, but a run
that opts into the required mode must fail if the URL or service is missing.
The CI contract below never permits a silent skip.

## Real cancellation test

The real suite uses two independent connections. The adapter connection:

1. starts a transaction;
2. inserts a unique sentinel row;
3. records its backend pid with `SELECT pg_backend_pid()`;
4. starts `SELECT pg_sleep(10)`; and
5. is interrupted well before the 15,000 ms statement bound.

The independent admin connection polls `pg_stat_activity` for that pid with a
bounded deadline and proves the backend has terminated. The test then proves
all of the following:

- the Effect returns promptly with a typed timeout/interruption error;
- the sentinel row is absent because terminating the connection rolled back
  the transaction;
- the adapter client is fenced and cannot be reused;
- an ordinary transaction commit persists its sentinel; and
- an ordinary body failure performs rollback and leaves no sentinel.

This must be an actual backend-termination assertion. A client-side timeout
that merely wins a race while `pg_sleep` continues is a failed test.

## CI service and sentinel guard

After the integration barrier, the coordinator adds a required CI job with a
PostgreSQL 17 service container. It follows the old bookings job at
`api/.github/workflows/api-ci.yml:276-410`:

- service image `postgres:17`, `pg_isready` health check, database
  `postgres`, and a test-only admin URL;
- install the already-reviewed repository dependencies with the frozen lock;
- remove a known sentinel path before the test;
- run the real suite under an external `timeout 120s` bound; and
- assert that the sentinel contains the exact completion string.

The proposed sentinel is:

```text
/tmp/api-next-control-plane-postgres-suite-complete
api-next-control-plane-postgres-suite-complete
```

The test writes the sentinel only from a passing suite teardown after all
real-Postgres assertions have run. A missing service, skipped test, crash,
hang, or partial test run therefore fails the job. The service job must remain
required alongside `bun run check`, `bun run test`, and the workerd suite.

No CI edit is made in this preparation tranche because 002 explicitly reserves
that change for the coordinator's integration barrier.

## Failure evidence

The handoff records the exact command, test count, image tag, URL mode (local
or service), sentinel contents, backend-termination poll bound, and any
environment limitation. It must not claim real cancellation from fake-driver
or workerd-only evidence.
