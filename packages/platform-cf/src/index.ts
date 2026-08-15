/**
 * @pirate/platform-cf — the only package importing `cloudflare:workers` or
 * Effect platform adapters.
 *
 * Lane C owns this package (api-next 001 §5) EXCEPT `config/`, which lane A
 * owns because config schema and contracts co-evolve (001 §3).
 */
export const platformCf = "api-next/platform-cf: lane C (001 §5), config/ lane A" as const;
