# Staging mainnet reader

The existing mainnet HSD node on the Spaces verifier host has a wallet-facing
RPC filter that permits broadcasts. The staging import must not use that filter.
This service binds a separate reader to `127.0.0.1:12039`. Its code accepts only
the five read methods used by HNS root observation and refuses every other RPC.
It forwards to the local HSD node through the existing HSD API key without
copying that key into the repository or a second file.

The reader requires a distinct staging client key delivered by systemd
`LoadCredential`. Only a pinned SSH local forward from the CI host may reach
the loopback listener. The SSH key on this host should allow forwarding only
to `127.0.0.1:12039`, with no shell, agent forwarding or remote forwarding.
The CI forward binds `127.0.0.1:24038`; both the staging provisioner and its
private observer driver use it. No public RPC port or HSD wallet capability is
opened for staging.

Run `node --test read-only-hsd-rpc-proxy.test.mjs` and `node --check
read-only-hsd-rpc-proxy.mjs` before installation. After starting the service,
send an authenticated `getblockchaininfo` through the local forward and verify
the mainnet genesis and fresh tip. Send a harmless `sendrawtransaction` method
name with a dummy value and require HTTP 403 without an upstream call. Compare
the existing Spaces RPC filter and HSD services as active before and after.
No Bob update is permitted until the staging verifier and provisioner agree on
the same safe block anchor.
