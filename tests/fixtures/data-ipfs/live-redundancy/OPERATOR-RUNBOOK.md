# Public song IPFS verification

The v1 staging path pins each song artifact individually through the Filebase
adapter with `wrap-with-directory=false`. It then retrieves that exact CID from
the Filebase dedicated gateway at
`https://highseas.myfilebase.com/ipfs/{cid}` and accepts the verification only
when the streamed byte length and SHA-256 match the retained artifact. This is
single-provider availability and integrity verification, not independent
replication, and no permanence beyond the provider's service is claimed.

Do not use Filebase MFS root operations, `/api/v0/files/flush`, the
`generateBucketCid` tag, provider-console bucket CID generation, a shared
bucket-root CID, or IPNS for this flow. Do not record or publish a Filebase
bucket-root or directory CID. No other gateway origin and no fallback provider
may be used for registration verification.

This path is public by design. Content requiring byte secrecy must remain in
private storage or be encrypted before any separate, explicitly ratified IPFS
flow.
