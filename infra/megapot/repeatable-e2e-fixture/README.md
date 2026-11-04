# Isolated repeatable Rewards contract

This fixture starts from the preserved repeatable fixture branch at 4b8a33d8. Only contract source, local test token, Foundry configuration and regression tests were copied. There is no runtime dependency on that historical branch.

The contract is restricted to Base Sepolia. Outcome is fixed before purchase. The operator may settle one purchased ticket early only with its exact drawing and ticket identifiers; the runner must separately prove the jobs Worker has read the canonical purchase receipt first. This operator action is test control and cannot prove public Megapot randomness or timing. Normal settlement and the empty-drawing reschedule remain available.

A losing drawing releases its reserved prize and reports tier zero. Its ticket cannot claim a payout. A winning drawing retains its prize reservation until the custody owner claims it. Earlier winning obligations stay reserved across later drawings.

Run forge test from this directory using pinned Foundry 1.8.3 and solc 0.8.30. This source has not been deployed.
