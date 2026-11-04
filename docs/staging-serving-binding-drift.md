# Staging serving bindings before deployment

Use `bun run deploy:worker --config apps/<worker>/wrangler.jsonc --env staging` for normal staging releases of every API Worker, including Jobs, HTTP, media, data registration, source gateway and the ownership verifier. Direct staging Wrangler deployment bypasses this release contract. CI's `wrangler deploy --dry-run` does not mutate the serving Worker and remains a packaging check. The production release paths are unchanged.

The normal release checks accepted Git source and a clean tracked configuration, retains the HTTP HNS gateway/Solid checks and retains rewards shutdown protection. It then reads the newest deployment's complete traffic allocation and each version receiving traffic. The candidate uses the installed Wrangler environment resolver and binding converter, with preview resource IDs removed. Unknown binding types, unresolved native resources, unsupported upload overrides, missing inventories and incomplete allocations refuse the release.

Each plaintext or JSON variable, native binding name, type and resource selection is compared with every serving version. The receipt contains hashes rather than variable values, credential values or author metadata. Existing secret bindings are retained exactly as Wrangler's normal upload retains them; their names and types participate in the baseline, and required secret names must exist. Different secret inventories across serving versions are ambiguous and refuse. Secret values are never hashed, read from provider secret storage or logged.

Durable Object namespace IDs are assigned by Cloudflare. The full baseline pins those IDs; candidate comparison uses the script, environment and class selection that Wrangler uploads. A namespace-ID change invalidates the reviewed baseline even if the class tuple is unchanged. Runtime compatibility date, flags, migration tag and usage model also participate. Unsupported runtime fields refuse rather than disappearing from comparison. Configurations using `keep_vars`, assets or unsafe metadata overrides require a supported resolver before this path will admit them.

An unexplained difference refuses before upload. Immediately before invoking deployment, inside the existing rewards guard, the tool recollects the candidate and serving baseline. Each collection reads the complete traffic allocation again after reading version metadata, and refuses movement during that read. It then verifies the exact source and checkout tree after the network reads and before invoking deployment. A changed source, version, traffic allocation, binding, namespace ID or runtime setting refuses. This is a fresh read before the provider command, not an atomic Cloudflare deployment lock; another actor can still change state after the final read. Coordinate releases through the existing single release owner and retain the postdeployment serving receipt.

For a read-only preview of a clean candidate branch, run `bun run check:staging:bindings --config apps/jobs-worker/wrangler.jsonc --env staging`. It emits the sanitized `staging_binding_preflight` receipt even when differences then make the command fail. This preview does not require the source to have merged, and it never invokes deployment. The actual deploy still requires accepted-main reachability.

For an intentional change, a coordinator reviews the exact source/configuration delta and the serving readback. Copy the receipt object, add `reviewed_by_role` and `review_expires_at`, and keep it in the external dated release evidence package, outside the repository. The expiry must be in the future and no more than thirty minutes away. Pass its absolute path with `--binding-review`. The file must match the source SHA, environment, configuration path, Worker name, baseline and candidate digests, every serving version/weight and the complete changes array. No wildcard, partial change list, skip flag or permanent waiver is accepted. Expiry is checked again before deployment. A receipt alone is evidence, not authorization to deploy.

The staging PCM flags in Jobs and media now persist the already approved serving value, true. Media also persists the existing source-gateway origin required by that activation; the active binding-contract test refuses an empty origin. Jobs version 4fbcbdb9 and media version 3652088c were read with that value after the October 1 correction. Initial disabled-rollout instructions describe the earlier activation boundary; they are not a request to revert the accepted staging setting. Production defaults, database policy and credentials remain unchanged. Historical song proof evidence and the September 30 to October 1 disabled interval remain in their existing handoff.


## Preserving Telegram staging activation

Normal staging HTTP and jobs deployments read TELEGRAM_CONFIG_JSON from every
version receiving traffic. All allocations must contain the same valid public
configuration. The effective candidate preserves those exact bytes; the
Telegram privilege guard and Wrangler --var upload use the same value. Missing,
malformed or conflicting values refuse before upload. Jobs cannot enable
linking. This preserves existing activation when checked-in defaults are off.
It does not provide an activation or flag-change operation: intentional changes
remain a separately reviewed runtime configuration workflow.

The serving allocation and all bindings are rechecked before upload. Existing
secret descriptors, HNS, Rewards, source provenance and unrelated drift review
remain governed by their existing checks. A reviewed drift receipt does not
substitute for an executable configuration override.

For a release pinned to an older accepted source, published clean maintained
tooling may pass --repository-root /absolute/exact-checkout along with
--source-ref <full-source-sha>. Both checkouts must share a Git common directory,
and both source identities must be reachable from accepted main with exact
clean tracked trees. Tooling defaults to origin/main; --tooling-source-ref
<full-accepted-sha> pins an older accepted tooling tree, including a feature
checkout whose tree matches its accepted squash merge. This option is staging-only. The Worker
is packaged from the target checkout, and Telegram schema admission executes
the target checkout's scripts/telegram-activation-preflight.ts, so a c28 release
does not silently acquire localization migration 0240's permission contract.
The binding preview accepts the same option. Use an admitted checkout and
preserve exact source and tooling identities in the release packet.
