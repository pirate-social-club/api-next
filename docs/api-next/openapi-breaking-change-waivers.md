# OpenAPI breaking-change waivers

`packages/contracts/breaking-change-waivers.json` contains temporary,
reviewed exceptions to the append-only OpenAPI gate. An entry applies only
when all of these values match:

- `baselineSha` is the full resolved commit SHA used by the gate.
- `operationId` resolves to exactly one operation in that baseline.
- `expectedViolations` is the complete breaking-change set for that operation.

`kind` records whether the ratified transition is a `clean-break` or a
`deprecation`. `reason` identifies the governing decision. Neither field
broadens the exception.

Expected violations are compared as a sorted exact set. A missing, additional,
changed, duplicate, unkeyed, or cross-operation violation fails closed. A
waiver for another baseline is inert, so it cannot authorize a later change.

Add a waiver in the same pull request as its reviewed contract transition.
Use the pull request base commit's full SHA and copy the exact detector output
for that operation. Remove the entry after the transition lands; completed
waivers are history, not permanent gate configuration.

The former 14 operation-wide deprecations and 41 clean-break allowances covered
transitions that had already landed. This change retires them instead of
inventing baseline SHAs and expected outputs after the review fact. Their
reasons remain available in repository history and the governing task records.
