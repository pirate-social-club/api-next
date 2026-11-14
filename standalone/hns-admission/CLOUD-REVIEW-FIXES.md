# Cloud review correction

The cloud review at 7db3bd7c returned HOLD with four P2 findings and several P3 observations. It independently passed installation, types/formatting, all 29 tests and offline bundling. It did not run HSD because Docker and the local image were unavailable. Its report found no failure, stale read or disagreement that produced authority. That historical checkpoint remains preserved.

The current successor passes TypeScript/formatting and all 40 focused cases. The updated real-HSD suite, current offline bundle and fresh independent source review remain unrun at this source checkpoint. The earlier CLEAR and HSD/bundle results belong to the earlier code; they do not clear this successor. Submission and installed-proof effects remain disabled.

## Findings and corrections

| Finding | Current treatment |
| --- | --- |
| Consent renewal conflicts with status polling | Repeated deadline checks make no new revision once consent is already expired. A real EOA renewal test keeps polling during the signing interval. Stale expected revisions fail before live preflight work. |
| One unavailable node blocks a two-node pair | Policy remains open. Current code still requires both configured nodes; a regression makes that behavior explicit. A trusted primary with fallback is an availability option for the pilot, not a capability silently added by this repair. Reachable disagreement must always block. No live observers have been configured or qualified. |
| Every GET rereads both observers | GET returns persisted status and retained record instructions without RPC. The response identifies source=retained_plan and requires comparing the current resource before publishing. Live whole-resource/epoch validation runs before consent commits. An unavailable preflight preserves revision and nonce for retry. Five GETs are tested to add zero observer reads. |
| Outage across maturity expiry cannot resume | Deadline expiry still stops scheduled work. An explicit re-observation can reuse the original timely publication if current mature evidence still matches. Expired consent can be renewed separately without changing the publication or maturity deadline. Renewal alone cannot establish readiness. Cancellation, ownership changes and late publication cannot recover to ReadyToSubmit. |
| Empty UPDATE breaks transfer-cancel history | Empty UPDATE is treated as preserving resource data. A deterministic history fixture preserves original inclusion; the actual transfer-cancel case is added to the HSD suite and remains unrun at this checkpoint. |
| Repeated bounded history walk | Canonical header checks are reused within one bracketed snapshot, never across polls or reorgs. The 64-step fixture falls from 328 to 200 RPC calls per node. The manifest can explicitly select maxHistory from 1 to 256; default remains 64. Deeper or missing history is unavailable. A cross-poll persistent history cache is not implemented. |
| Valid future tip timestamps | The future-block allowance follows pinned HSD's two-hour rule. A future publication still waits until its inclusion time before readiness. Two-node agreement and all other freshness/canonical checks remain required. |
| Backward wall-clock read | The pure transition function clamps event time to its prior updatedAt instead of throwing or reopening a deadline. |

Before their relevant fixes, the new probes reproduced renewal conflict, extra GET reads, failed maturity recovery, clock_regression, lost inclusion after empty UPDATE, 328 history calls and refusal of a tip inside HSD's future allowance. Negative authority/cancellation controls passed. Current focused tests pass with those failures corrected.

## Deliberately unchanged boundaries

An unknown operation lookup still performs one bounded ID lookup before authorization because the stored binding is required to verify its exact request signature. It returns no operation data before authorization. Deployment must apply request/rate controls; no new public operation-discovery API is introduced.

The v1 request signature binds chain, wrapper, complete installation binding, method, exact path/body, nonce and a maximum five-minute lifetime. It does not bind service origin. Changing signed preimages requires a reviewed protocol version rather than an incidental correctness patch. A caller must pin its configured trusted service origin. There are no submission, signing or spending effects to replay in this service.

The default history bound can still make a busy name temporarily unsupported. A larger explicit bound does not bypass the 30-second snapshot deadline or make unavailable history negative evidence. [Current Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests) list 50 subrequests on Free and 10,000 by default on Paid. The history reader requires qualification on a suitable paid configuration; no Free-plan deployment is claimed. A worst-case pair with disjoint 256-step histories is bounded by 3,088 observer RPC calls, plus runtime/storage overhead. Actual deployed CPU, time, subrequests and observer latency remain unqualified.

The two-hour allowance is taken from [pinned HSD chain validation](https://github.com/handshake-org/hsd/blob/698e252ebc7b5c1dd0a9587e342fdd153d020ae4/lib/blockchain/chain.js#L549). This changes a conservative freshness heuristic, not challenge/signature bytes or accepted quorum. No HNS node, credential, provider, contract or live resource changed.
