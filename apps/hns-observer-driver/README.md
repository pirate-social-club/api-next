# HNS observer driver

The authority-successor observation harness owns acquisition of every live
fact. Its source port returns the retained owner-authoritative observer
snapshot, complete chain record set, both DNS views, active inventory, exact
host row identities and generations, and the five canonical artifacts. The
harness accepts no operator arguments and emits one bounded canonical
observation document. Candidate preparation runs before that document is
emitted and performs no reservation or persistence.

The authority-successor emitter is the stdout-only second stage. It accepts
only the canonical observation document produced by the harness, rechecks the
retained observer snapshot reference and digest, rechecks the generation tuple
digest, and reruns complete candidate preparation before writing exact
candidate bytes. It does not accept separate paths or operator-entered chain,
DNS-view, inventory, row-identity, or generation fields.

Run it from the repository root with one explicit absolute input path:

```sh
bun run hns:emit-authority-successor -- --input /absolute/path/observation.json
```

The input is compact canonical JSON. It embeds all five exact artifacts rather
than referring to mutable files. Its source provenance binds the observer
evidence to the retained snapshot reference and snapshot SHA-256. A separate
digest binds the exact DNS and app-host activation identifiers, their current
generations, the successor health generation, and the database observation
time. The reviewed observer evidence must use `owner_authoritative_dns_txt`;
the parent-chain TXT mode deliberately cannot produce a successor package.

The adapter bounds its one read, strictly decodes the document, and delegates
all canonical and semantic parity checks to the application gate. It writes
exact candidate JSON bytes to stdout only after the complete package passes.
Any argument, read, decode, provenance, canonicality, observation, parity, or
semantic failure produces no candidate bytes. Redirecting stdout to a new
review file is an operator action; neither stage reserves a generation or
persists authority state.
