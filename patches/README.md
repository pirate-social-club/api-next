The node-forge RSA patches backport strict ASN.1 element counts for
GHSA-86w9-cpqp-85rv. The registry copy already checks the outer DigestInfo;
it now also checks the nested DigestAlgorithm. The SDK fork receives both
checks, preserving its remaining behavior and pinned source.

The reference is the proposed upstream fix at
https://github.com/digitalbazaar/forge/pull/1152, commit
ceba34402e329f0365134f23fe19898756527d65. No patched registry version was
available on October4. This is a maintained backport, not an upstream release.
Package versions are unchanged. Bun patchedDependencies and the frozen lock
apply the reviewed files during installation.

scripts/node-forge-remediation.ts checks the exact patch and installed RSA
hashes for both resolved copies, then signs valid and malformed DigestInfo
structures. Valid signatures with and without NULL parameters must pass;
extra outer or nested elements must fail. The advisory gate recognizes this
one remediated finding only after those checks. All other findings, thresholds
and risk exceptions remain governed by the existing policy. Missing, changed
or unpatched files fail the gate.

When upstream publishes the fix, replace these patches with a reviewed upgrade
and remove the matching remediation recognizer together. Do not remove the
hash or signature checks while retaining an affected version.
