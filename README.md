# api-next

Clean-foundation rewrite of the Pirate API on Effect TS v4 and Cloudflare
Workers, replacing `api/services/api` feature by feature. Modular monolith:
`contracts` / `domain` / `application` / `platform-cf` / `testing` packages,
`http-worker` and `jobs-worker` deployables.

Specs live in the workspace control plane (`../docs/specs/api-next/`):
`000-foundation.md` for architecture and milestones, `001-execution-lanes.md`
for lane ownership and mechanics. Gates: `bun run check`, then `bun test`.

Deploy an existing Worker environment only from a clean checkout whose tree
matches an accepted main commit:

```sh
bun run deploy:worker -- --config apps/jobs-worker/wrangler.jsonc --env staging --source-ref origin/main
```

The command derives the full source SHA, writes it as the immutable Cloudflare
version message, verifies that annotation through Wrangler's JSON version list,
and prints a small receipt. It never lists or reads Worker secrets.

## Type checking

`bun run typecheck` uses tsrs for fast local feedback. tsrs is pinned to
`0.18.0-ts7.1.0-dev.20260929`; update it deliberately after comparing diagnostics
with the official compiler. The API command checks all seven TypeScript projects.
The full `bun run check` also uses tsrs and retains the separate Effect
diagnostic checks.

CI additionally requires `bun run typecheck:typescript`, which uses the retained
official TypeScript dependency across the same projects. The TypeScript package
also remains available to tools that import its compiler API. Both compilers
consume the same configuration and strictness settings; tsrs is currently an
experimental compiler and does not replace the official editor setup.
