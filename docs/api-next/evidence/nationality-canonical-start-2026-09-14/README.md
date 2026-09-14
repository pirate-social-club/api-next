# Nationality provider-switch start evidence

The application start service now reserves and revalidates the server-resolved child ceremony identity when a provider switch advances its generation. Creation and join resolvers supply that internal identity; it is stripped before provider dispatch. Frozen creation reservation variants remain unchanged.

The final bounded serial validation completed with exit zero: full check; 19 PostgreSQL tests across the nationality join and creator flow suites with two fresh completion sentinels; 4,141 unit tests; 20 Node tests; and all five workerd configurations with 82, 74, 2, 10 and 15 tests. PostgreSQL proofs use the real application start service and database reservation/finalization with deterministic local provider adapters. They do not establish live document-provider acceptance. The task-owned database container and socket directory were removed.

Earlier attempts exposed a missing fixture clock, an incorrect store argument, a dependency-boundary violation from locating provider fixtures in platform code, and a creation assertion expecting a start action after a session had started. These were corrected before the retained final runs. Fixtures now live in the testing package with an injected application store port.

Handle checkout, shared failed-session retry, adult viewing, consumer rollout, the complete PostgreSQL partitions and live staging acceptance remain separate work. No feature was enabled or deployed.
