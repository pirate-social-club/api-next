# Production-hosted Aeneid DATA registration

This runbook covers the production api-next Workers while they register DATA
records on Story's Aeneid testnet. It does not authorize Story mainnet, Lit
signing, signer creation, secret installation, faucet requests, deployment,
database migration, runtime activation, or a transaction. Those actions remain
with their owning tasks and require their recorded authority.

The production Aeneid signer ceremony recorded the public address on 2026-08-30.
The runtime must stay disabled until the infrastructure task has installed only
the matching production secret into the production data-registration Worker and
the later readiness tasks have supplied their own evidence and authority.

## Fixed identity and transaction boundary

The approved network is Story Aeneid testnet, chain ID `1315`. The official RPC
is `https://aeneid.storyrpc.io`. Story's Aeneid documentation is the authority
for the current RPC, explorers, and official faucet:
<https://docs.story.foundation/aeneid>.

The configured SPG NFT contract is
`0xc32A8a0FF3beDDDa58393d022aF433e78739FAbc`. The signer may target only these
reviewed Aeneid workflow contracts:

- license workflow: `0xcC2E862bCee5B6036Db0de6E06Ae87e524a79fd8`;
- royalty workflow: `0xa38f42B8d33809917f23997B8423054aAB97322C`;
- registration workflow: `0xbe39E1C756e921BD25DF86e7AAa31106d1eb0424`
  (`mintAndRegisterIp` only, for original-video register_ip actions that carry
  no license terms).

The production signer address is
`0x91016D653FDa20E7C8eb2a1E6710a6504C5d1E7d`. The same checksummed address is
committed as `DATA_REGISTRATION_SIGNER_ADDRESS` in both the data-registration
and jobs production environments. It must derive from
`DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY`; neither environment may read
or fall back to the staging key.

Every approved request is in the `data_registration` namespace, carries zero
native value, and is bounded by the persisted signing intent, target and method
allowlists, deadline, gas limit, and fee ceilings. The direct-key adapter signs
offline. It cannot select or broadcast a transaction.

## Ceremony and funding

The signer ceremony task owns creation of a fresh production-environment EOA,
recording its public address, storing its private key under the exact production
Infisical name, and requesting testnet gas. The approved funding source is the
official faucet linked from Story's Aeneid documentation. Do not use a personal
wallet, staging signer, Megapot balance, bridge, exchange, or mainnet funds.

The ceremony record must identify the task and date, the public signer address,
the authoritative faucet page, the transaction hash of the faucet grant, and
the observed post-funding balance. It must never contain the private key or an
export of the Infisical value. Replenishment repeats this authorization and
evidence path; an alert is not authority to request funds.

## Reserve states

The jobs Worker emits `operations.balance.snapshot` for the exact configured
address. The existing policy has these meanings:

- `sufficient`: balance is at least `0.2 IP`. Normal disabled-first readiness
  work may continue.
- `low`: balance is at least `0.0075 IP` but below `0.2 IP`. Keep the lane from
  starting new canary work and obtain replenishment authority.
- `blocked`: balance is below `0.0075 IP`. Do not sign or broadcast; disable the
  DATA lane if it is active.
- `unavailable`: the balance could not be read. Treat the reserve as unknown,
  keep activation blocked, and verify the RPC and signer identity before any
  other response.

Faucet gas is testnet-only, but the signer still represents the provenance of
the test registration. Rotate it and record the incident if custody is
suspected to be compromised.

## Pre-activation evidence

Before either production flag changes from `false`, the reviewer must confirm
all of the following from redacted evidence:

1. Both production Worker configurations name environment `production`, chain
   ID `1315`, the official Aeneid RPC, and the same non-empty signer address.
2. `eth_chainId` from the reviewed RPC is `0x523`, and the signer balance is
   read from that same RPC for the exact recorded address.
3. The SPG NFT contract and both allowlisted workflow addresses have non-empty
   bytecode on Aeneid. The addresses match the reviewed source constants.
4. An offline derivation from the installed production secret matches the
   recorded public address. The check exposes only the address and a pass/fail
   result.
5. The balance snapshot is fresh and `sufficient`, with at least `0.2 IP`.
6. The production signer and Filebase secret names exist only at the approved
   Infisical path and only the data-registration Worker receives them. Their
   staging counterparts are absent from the production Worker's bindings.
7. Focused signer, composition, binding, and balance tests pass, followed by the
   repository check and complete test gates required by the owning task.
8. The disabled deployment and maintenance observation tasks have recorded
   their own successful evidence. A passing implementation branch is not
   deployment or activation authority.

Any mismatch, empty contract bytecode, stale observation, missing secret,
unexpected secret binding, or unavailable RPC is fail-closed. Correct the
owning configuration or ceremony record; do not substitute a sibling identity
or endpoint during activation.

## Activation and emergency disablement

Activation belongs to the later canary task. It enables only
`DATA_REGISTRATION_ENABLED` for the production data-registration Worker and the
production jobs Worker under the task's reviewed sequence. It must not change
media processing, HNS ownership, Megapot rewards, or unrelated schedules.

To stop the lane, set `DATA_REGISTRATION_ENABLED=false` in those same two
production environments and deploy only the reviewed Worker changes under the
incident or operations authority. Leave unrelated job flags and bindings
unchanged. Confirm the data-registration composition reports disabled, the jobs
Worker stops DATA dispatch and maintenance, and no new DATA signing attempt is
created. Preserve pending database state for later reconciliation; disabling
the lane does not authorize deleting records, queues, workflows, secrets, or
the signer.

## Redaction boundary

Never copy a private key, secret value, credential-bearing RPC URL, provider
token, raw authorization header, private media, or an Infisical export into
documentation, logs, tickets, command output, or evidence. Do not hash a
private key as proof. Safe evidence consists of public addresses, public chain
and contract identifiers, transaction hashes, secret names, binding names,
version identifiers, balances, timestamps, and pass/fail results that cannot be
used to reconstruct a credential.
