# api-next

Clean-foundation rewrite of the Pirate API on Effect TS v4 and Cloudflare
Workers, replacing `api/services/api` feature by feature. Modular monolith:
`contracts` / `domain` / `application` / `platform-cf` / `testing` packages,
`http-worker` and `jobs-worker` deployables.

Specs live in the workspace control plane (`../docs/specs/api-next/`):
`000-foundation.md` for architecture and milestones, `001-execution-lanes.md`
for lane ownership and mechanics. Gates: `bun run check`, then `bun test`.
