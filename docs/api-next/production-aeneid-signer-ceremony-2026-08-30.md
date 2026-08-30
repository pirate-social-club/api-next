# Production Aeneid signer ceremony evidence

The `song-production-aeneid-signer-ceremony` task authorized this ceremony on
2026-08-30 for the api-next production environment. The scope was limited to a
fresh testnet-only signer, its exact Infisical custody record, public
configuration, and one official Aeneid faucet request of no more than 10 IP.

## Custody evidence

The ceremony generated one fresh EOA in process memory and streamed its private
key directly to Infisical environment `prod`, path `/services/api-next`, under
the exact shared-secret name
`DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY`. The public address is:

`0x91016D653FDa20E7C8eb2a1E6710a6504C5d1E7d`

A name-only query confirmed that the secret is present at the approved
production path and absent from the corresponding staging path. The development
environment has no `/services/api-next` folder. An offline derivation from the
stored value returned the same checksummed address. The private key was not
printed, placed in a command argument, written to disk, exported, committed, or
copied into ceremony evidence.

The same public address is recorded in the disabled production configurations
for the data-registration and jobs Workers. Both
`DATA_REGISTRATION_ENABLED` flags remain `false`. The ceremony did not install
the value into Cloudflare; that synchronization remains owned by the production
infrastructure task.

## Funding evidence

The approved source was the official Story Aeneid faucet at
<https://aeneid.faucet.story.foundation>. The operator requested 4.2 IP, which
is within the authorized maximum and above the 0.2 IP reserve floor. The faucet
transfer settled at the on-chain block timestamp `2026-08-30T04:47:53Z` in
block `22926911`:

<https://aeneid.storyscan.io/tx/0xf3714972cbbd943ca0a1634b6391556f84e535b7710bec5cff6797e17b91bc45>

The approved public RPC `https://aeneid.storyrpc.io` reported chain ID `1315`,
successful receipt status `0x1`, the exact destination address, and a balance of
`4.200000000000000000 IP` at `2026-08-30T04:50:36Z`.

## Result and handoff

The custody, identity, chain, transaction, and reserve checks passed. Staging,
mainnet, value-bearing custody, deployments, migrations, runtime flags, and DATA
registration transactions were untouched. The infrastructure task may later
synchronize only the approved production secret into the disabled
data-registration Worker under its own authority. This evidence does not grant
that authority or authorize activation.
