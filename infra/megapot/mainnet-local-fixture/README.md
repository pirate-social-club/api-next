# Mainnet local fixture and Safe settlement source candidates

These sources are unaccepted. Parent compilation with pinned
Foundry1.8.3/solc0.8.30 succeeded using the portable commands below: nine tests
passed (three drawing, six credit), and test/build exited zero after the admitted
peer-review repair. The new adversarial token and four additional tests await
parent compilation. Compiler lint diagnostics remain retained; this is not a warning-free
build or financial acceptance.
They select no live deployment,
Safe root, independent authority, custody backend, numerical cap or gas policy.
Production Rewards stays off. Existing Sepolia fixture sources are unchanged.

`ControlledMainnetMegapot` is a separately named deterministic chain8453 fixture
for the pinned loopback fork. It fixes win/loss before purchase and exposes the
existing Megapot ABI. A winning claim burns the actual fixture NFT and transfers
net tokens, while gross minus net remains a reserved referral liability. A loss
releases only its reserved prize. It cannot establish deployed Megapot randomness
or production conformance. The separate original contract-flow test establishes
limited approval/purchase conformance against the actual pinned deployment.

`RewardCreditSettlement` is a proposed Safe module execution boundary. Its
immutable inputs bind the Safe root, token, independent credit authority and
aggregate cap. An EIP712 signature binds the credit ID, recipient, atomic amount,
expiry, root, token, chain and module. Credits are consumed once, spend is capped,
and a failed or false-returning transfer reverts credit and budget consumption.
It exposes neither arbitrary calls nor approval/delegatecall or policy reset.
Only the explicitly pinned loopback test harness constructs or enables this module. Independent authority issuance
must derive from verified immutable credit/Claim/wallet evidence through a
separately reviewed port, rather than trusting the sending process's assertion.

Foundry tests use a Safe **interface double**. They cannot prove actual Safe
module execution, enabled-module admission, Safe owner policy, or persisted
settlement. Separate API fork tests use digest-verified released Safe artifacts,
an ephemeral fake owner and independent issuer, genuine Safe enable/disable calls,
and actual forked Circle USDC. The PostgreSQL lifecycle test journals backing,
authorization, unsigned nonce/instructions, signed bytes, uncertain broadcast and
finalized module/Transfer evidence across process restarts. These local tests do
not select a production policy. The application shared token-send interpreter
still implements direct ERC20 sends; it is not this Safe execution path.

The repaired cross-module test enables both modules on the same root/token with
the same authority. It checks exact `InvalidCredit` revert data in both replay
directions and unchanged balances, consumption and budgets, then proves that
each module's own signature succeeds. The separate disabled-module case remains
disabled. This closes the prior false-positive path through module admission;
it does not itself establish independent typed-data vectors or actual Safe execution.

`AdversarialCreditToken` adds balance-changing false/reverted transfers, empty,
malformed and noncanonical return data, and callbacks carrying same-credit or
different valid credit data. The new Forge tests require the exact reentry error,
unchanged nested consumption/budget, complete rollback and a later successful
independent credit. Their Safe remains an interface double. Actual released Safe
execution of these new cases requires the parent-compiled token artifact and a
subsequent local fork run; no skipped test is proof of that boundary.

Parent has supplied released Safe1.4.1 local-test artifacts and provenance from
`@safe-global/safe-contracts`1.4.1-2, gitHead
`aa14911666deb13cdbbe37c37253a55918525437`. The pinned registry commit is
`e9cc9798ab834e7fe515d361566eb4a28c65387f`; supplied evidence matches Safe,
SafeL2 and SafeProxyFactory deployed code on the pinned fork. This intake is for
local fake-owner tests only and selects no production wallet/backend policy.

Parent compilation uses pinned Foundry1.8.3 and solc0.8.30, matching the existing
fixture toolchain. Run `forge test --root infra/megapot/mainnet-local-fixture` and
`forge build --root infra/megapot/mainnet-local-fixture` only in task-local parent
tool custody. Return exact source/artifact hashes and actual pass/fail output.
The owned remapping in `foundry.toml` resolves the unchanged sibling fixture
through `../repeatable-e2e-fixture/`, with only that sibling added to compiler
read paths. Source imports use the explicit `repeatable-e2e-fixture/` alias.
No absolute CLI remapping or `--lib-paths` argument is needed. From a parent
container's `/repo` working directory, use the same relative `--root` command;
source may remain read-only while the configured ignored output/cache is writable.
No source session Docker, global install, credentials or public transaction is
needed. Generated compiler output is task-local ignored evidence, not publication.
