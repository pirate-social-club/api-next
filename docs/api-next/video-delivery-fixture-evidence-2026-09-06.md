# Delivery composed and scale fixture evidence

These are local Workerd and pinned PostgreSQL 17 measurements, not staging,
provider acceptance, network latency estimates or a backend deployability claim.
The executable evidence is in tests/workerd-video/enrichment-drill.ts and
delivery-scale.test.ts. Run with test:video-workflow:postgres and an isolated
CONTROL_PLANE_POSTGRES_TEST_URL. The sample below was collected on 2026-09-06.

## Enrichment recovery

The drill runs analysis through the exported Workflow to publication, scheduled
enrichment dispatch through the production queue handler, and the exported
Workflow through production delivery composition and real leased PostgreSQL
repositories. Only provider HTTP, bucket bindings and Workflow step persistence
are fixtures. It loses the accepted copy response and then loses completion
acknowledgement after the ready commit. Replay observes one copy, one grant,
two provider lookups, ready outboxes and ready Post projection without another
eligible dispatch. This is not a live Cloudflare Workflow scheduler proof.

Constructing the real Workerd Request exposed an unsupported redirect:error
mode in the transport. The adapter now uses manual and rejects non-success
responses without following redirects or forwarding credentials/source grants.

## Feed and poster cost

Each fixture contains N valid video publications and one text Post. Readiness
is seeded for measurement only; the composed drill above owns readiness proof.
Requests are serial. Storage is synthetic R2 with a lazily streamed 65,536-byte
payload; this is a byte-transfer fixture, not JPEG decoding evidence. The actual
feed store, poster handler, authorization and artifact SQL adapters execute.

For N=1/10/20, each poster pass performs N authorizations, 4N database
connections and N R2 reads. Public views execute 11N SQL statements; member-only
views execute 12N. Both 200 and matching-ETag 304 incur these reads. A 200 pass
streams 65,536/655,360/1,310,720 bytes respectively from storage to response;
a 304 pass streams zero bytes. No eligibility caching or bypass was introduced.

| Viewer | N | Feed queries | Feed DB/elapsed ms | 200 DB/elapsed ms | 200 p50/p95 ms | 304 DB/elapsed ms | 304 p50/p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Public | 1 | 1 | 18/28 | 32/65 | 65/65 | 30/58 | 58/58 |
| Member | 1 | 1 | 15/22 | 38/62 | 62/62 | 33/58 | 58/58 |
| Public | 10 | 1 | 17/24 | 329/567 | 57/59 | 322/547 | 55/56 |
| Member | 10 | 1 | 15/22 | 344/592 | 57/71 | 351/605 | 58/80 |
| Public | 20 | 2 | 32/47 | 650/1119 | 56/58 | 680/1157 | 57/61 |
| Member | 20 | 2 | 39/55 | 818/1411 | 67/81 | 738/1221 | 61/65 |

Feed queries each use one connection; N=20 spans two pages containing 21
items. DB time sums query execution, not connection setup. Poster percentiles
describe this small local sample, not an SLO. Production R2/network cost remains
unmeasured. Member fixtures use an authenticated member viewing members-only
Posts. Denial equivalence is covered by separate access tests, not this sample.

The first equal-rank fixture exposed an existing pagination defect: the feed
cursor floors creation time to seconds while SQL compares full timestamps, so
a same-rank item within that second can be skipped. Distinct ranks isolate this
measurement from that defect. Pagination repair is not included in delivery.

## Remaining boundaries

The HTTP harness shares production handler factories and the binary-response
helper, proving handler authorization before conditional 304, not the entire
outer deployed Worker assembly. It must not be described as a live-stack proof.

The dedicated stage-timings ledger remains execution-owned. If absent at merge,
delivery timing events are explicitly deferred under the owner ruling; no local
replacement table or readiness dependency is permitted. Routine/incident key
rotation, live Stream enforcement, provider acceptance and browser acceptance
remain separately authorized staging obligations.
