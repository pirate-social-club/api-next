# Handle nationality authoring checkpoint, 2026-09-14

This checkpoint implements authorized, server-resolved nationality qualification authoring and the offering successor. It does not yet implement qualified quotes or claims: those paths explicitly fail closed. Existing none_v1 and private direct grants retain their established behavior.

The owner-approved lifetime is 365 days (31,536,000 seconds) from accepted proof observation, subject to earlier expiry and the existing binding, requirement and revocation checks. Configuration remains explicit and disabled by default. Nothing was enabled, advertised, pushed or deployed.

Full `bun run check` passed, including 176 migration checks and immutable api-client 0.75.0 verification. The complete test chain was run serially: `bun run test:unit` passed 4,137 tests, `bun run test:node` passed 20, then the five workerd configurations passed 82, 74, 2, 10 and 15 tests respectively. Each workerd command used `--maxWorkers=1 --no-file-parallelism`. The shell chain exited zero. Runtime cancellation diagnostics remain visible in the retained log; the configurations themselves passed.

The socket-mounted PostgreSQL 17 run passed five new authoring tests and five existing handle-sales tests, with two fresh suite completion markers. Its wrapper exited zero and removed its container and socket directory. The offering proof uses the existing namespace-effectiveness fixture substitution, not a live HNS acceptance result. Focused domain tests passed 22 and HTTP tests passed 11. All heavy commands ran serially inside a CPU- and memory-bounded systemd scope.

Migration 0180 was allocated after checking the song recovery lane's reservation of 0176–0179. It adds immutable nationality policy authoring and extends the offering insert guard; the baseline and reset script were regenerated. The public schemas and packed client add authoring routes and offering qualification references. No old quote hash or private qualification hash is widened to accept the new shape.

Outstanding work includes qualified quote snapshots, buyer ceremonies, reservation and claim rechecks, join refetch and proof-renewal regressions, adult viewing, metadata, Solid flows and the full acceptance gates. Four-shard PostgreSQL, trusted remote secret-boundary and live staging acceptance have not run for this checkpoint.
