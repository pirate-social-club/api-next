# HNS observer driver

The authority-successor emitter is the operator-facing, stdout-only adapter for
turning one complete read-only observation package into exact candidate bytes.
It does not contact a database, HSD, DNS authority, provider, or credential
source itself. A separately authorized observer ceremony must produce the
input document and the five referenced canonical artifacts first.

Run it from the repository root with one explicit absolute input path:

```sh
bun run hns:emit-authority-successor -- --input /absolute/path/emission-input.json
```

The input must be compact canonical JSON in this exact member order:
`version`, `source_commit`, `root_label`, `observed_at`, `chain_height`,
`expected_chain_network`, `chain_authority_records`, `generation_snapshot`,
`expected_authority_addresses`, `authority_views`, and `artifact_paths`.
`chain_authority_records` must be the exact NS, glue, and DS records from the
stable chain observation. The reviewed observer evidence must use
`owner_authoritative_dns_txt`, whose chain-authority digest binds those
records; the parent-chain TXT mode deliberately does not. The generation
snapshot contains the exact DNS and app-host row identifiers as well as their
generation numbers. `artifact_paths` must name distinct absolute paths for
`authority_inventory`, `dns_zone_activation`, `app_host_activation`,
`health_observation`, and `observer_evidence`, in that order. No root, network,
authority address, database, credential, artifact, or output path has a
default.

The adapter bounds every read, strictly decodes the input, reads each artifact
once, and delegates all canonical and semantic parity checks to the application
gate. It writes exact candidate JSON bytes to stdout only after the complete
package passes. Any argument, read, decode, canonicality, observation, parity,
or semantic failure produces no candidate bytes. Redirecting stdout to a new
review file is an operator action; the adapter never reserves a generation or
persists authority state.
