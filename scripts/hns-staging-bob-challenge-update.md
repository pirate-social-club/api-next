# Staging 8s28 challenge update

This operator command handles only the Bob transaction for a fresh staging
full import of 8s28. It does not reset staging, start an import, acknowledge
publication, activate a route, or claim a name. Run it only after the prior
staging binding has been released through a reviewed reset and Pirate has
issued a new full-import publish plan.

The absolute ceremony directory must be private and contain
`publish-plan.json`, the exact plan bytes whose SHA-256 Pirate returned, and
`session.json` with `root`, `sessionId`, `planSha256`, and
`publicationDeadline`. Do not pretty-print or otherwise rewrite the plan
unless its exact bytes still have the returned digest. The command verifies
that the plan swaps one old Pirate verification TXT for one new TXT while
preserving every other record, including the staging NS, glue, and DS records.
It also verifies Bob's wallet and safe chain agree with the plan's current
resource.

From the api-next repository:

```sh
node scripts/hns-staging-bob-challenge-update.cjs --plan /absolute/private/ceremony-directory
node scripts/hns-staging-bob-challenge-update.cjs --execute /absolute/private/ceremony-directory
```

The command uses the existing local Bob service and psc2 wallet. It reads the
wallet API keys and psc2 passphrase from the Bob tool's private `.env` file,
unlocks through the wallet API for signing, and locks again. The passphrase is
never passed as a command argument or printed. Set `BOB_TOOL_ROOT` only when
the Bob tool is outside its usual local directory.

`--plan` records the exact unsigned update and refuses a fee above 1 HNS.
`--execute` checks the wallet and chain again, verifies the signed transaction,
and writes `before-broadcast.json` with the transaction ID before one
broadcast. If broadcast acknowledgement is unclear, the retained transaction
ID must be reconciled against Bob and the chain. The command refuses every
second attempt from that ceremony directory.
