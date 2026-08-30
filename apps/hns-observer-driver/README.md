# HNS observer driver

The authority-successor observation harness owns acquisition of every live
fact. Its source port returns detached read-only observer evidence, the
complete child and parent chain record sets, both child and parent DNS views,
active inventory, exact host row identities and generations, and the five
canonical artifacts. The harness accepts no operator arguments and emits one
bounded canonical observation document. Candidate preparation runs before
that document is emitted and performs no reservation or persistence.

The concrete live-authority source adapter is not wired yet, so there is no
operator command for the first stage. Do not assemble a source observation by
hand or treat the pure harness tests as a live observation. The operator
composition must derive chain, DNS, and gateway facts through that read-only
adapter and preserve their exact transcripts. The platform PostgreSQL readers
independently supply the current authority inventory and exact generation-row
snapshot; neither fact may come from the live-authority adapter.

The driver now owns a bounded multi-message DNS-over-TCP acquisition primitive
and a fixed HMAC-SHA256 TSIG AXFR session. The session signs the request,
verifies every response message in the running MAC chain, and accepts a
transfer only when identical apex SOA records bracket in-zone data containing
an apex NS RRset. The composed acquisition serializes the exact message
sequence with DNS-over-TCP length prefixes. The separate pure canonicalizer
reconstructs stable zone bytes from that sequence. Record order and
compression do not affect those bytes; online RRSIG material is omitted
because its timing and signature bytes may differ while the separately bound
DNSKEY/DS-authenticated zone content is equal.

The remaining source adapter must put each authority's framed response
sequence into the detached transcript. The harness independently reconstructs
both canonical zones, requires byte equality, derives the view digest, and
builds the DNS persistence artifact from those bytes. The live-authority port
has no zone-bytes or zone-digest input.

The private driver exposes the authenticated transfer through a separate
bounded protocol path. A request can select only a preconfigured root, view,
nameserver, address, and non-secret credential reference. The connector and a
cloned TSIG secret remain inside the driver; neither the request nor response
carries the secret. A successful response contains the exact signed request
and the exact framed, already authenticated response sequence. The Worker-side
transport rechecks the closed response envelope and all bounds. This seam is
not yet composed into the complete live-authority source, so no concrete
operator command exists.

The HSD transcript is a closed stable bracket, not only two resource reads. It
contains tip information and the matching tip header before observation, the
fixed mainnet genesis header, active-name and expiry state, child and parent
resources, then the same tip information and header after observation. The
candidate builder decodes those exact bytes and binds the reported height,
block hash, median time, expiry height, delegation, DS, and ownership TXT to
them.

The authority-successor emitter is the stdout-only second stage. It accepts
only the canonical observation document produced by the harness, rechecks the
detached observer evidence reference and transcript digest, rechecks the
generation tuple digest, and reruns complete candidate preparation before
writing exact candidate bytes. It does not accept separate paths or
operator-entered chain, DNS-view, inventory, row-identity, or generation
fields.

Run it from the repository root with one explicit absolute input path:

```sh
bun run hns:emit-authority-successor -- --input /absolute/path/observation.json
```

The input is compact canonical JSON. It embeds all five exact artifacts rather
than referring to mutable files. Its source provenance binds the observer
evidence reference to the exact detached transcript SHA-256. A separate digest
binds the exact DNS and app-host activation identifiers, their current
generations, the successor health generation, and the database observation
time. The reviewed observer evidence must use
`owner_authoritative_dns_txt`; the parent-chain TXT mode deliberately cannot
produce a successor package.

The adapter bounds its one read, strictly decodes the document, and delegates
all canonical and semantic parity checks to the application gate. It writes
exact candidate JSON bytes to stdout only after the complete package passes.
Any argument, read, decode, provenance, canonicality, observation, parity, or
semantic failure produces no candidate bytes. Redirecting stdout to a new
review file is an operator action; neither stage reserves a generation or
persists authority state.
