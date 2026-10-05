import { fixtureAccounts } from "./browser-accounts.mjs";
import { fixturePersonas } from "./run-evidence.mjs";
export function singleParticipantCredit(credits, role) {
  if (!["study", "karaoke"].includes(role)) throw Error("Participant role differs");
  const rows = credits.filter((credit) => credit.account_id === fixtureAccounts[role].accountId);
  if (
    rows.length !== 1 ||
    rows[0].payout_persona_id !== fixturePersonas[role] ||
    rows[0].amount_atomic !== "500000"
  )
    throw Error("Participant allocation differs from two equal fixture shares");
  return rows[0];
}
