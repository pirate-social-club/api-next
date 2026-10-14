// Test-only failure metadata. No SQL/value/credential/body/result substitution.
import { Client } from "pg";
import type { PostgresClientFactory } from "./postgres.ts";

const label = (text: string): string => {
  if (text === "SELECT lock_reward_credit_for_payout_v1($1)") return "original-identity.lock";
  if (text === "SELECT lock_reward_send_financial_source_v1($1)") return "original-source.lock";
  if (text === "SELECT require_reward_credit_new_spend_authority_v1($1,$2,$3,$4,$5,$6)")
    return "current-actor.recheck";
  if (text.startsWith("INSERT INTO reward_winner_sends")) return "winner-send.create";
  if (text.startsWith("INSERT INTO reward_winner_send_attempts"))
    return "winner-send.attempt.create";
  if (text.startsWith("INSERT INTO reward_gas_topups")) return "gas-topup.create";
  if (text === "COMMIT") return "transaction.commit";
  return "other-statement";
};
const messages = new Set([
  "query returned no rows",
  "query returned more than one row",
  "credit unavailable",
  "current financial authority unavailable",
  "original paid recipient unavailable for a new spend",
  "canonical gas budget authority unavailable",
  "gas must retain its original credit recipient",
  "a reward gas top-up must target the confirmed payout wallet",
]);
export const rewardFinancialSourceDiagnosticClientFactory: PostgresClientFactory = (
  _url,
  config,
) => {
  const client = new Client(config);
  return {
    connection: client.connection,
    connect: () => client.connect(),
    end: () => client.end(),
    query: async ({ text, values }) => {
      try {
        return await client.query({ text, values: values === undefined ? [] : [...values] });
      } catch (error) {
        if (error !== null && typeof error === "object") {
          const code = Reflect.get(error, "code"),
            constraint = Reflect.get(error, "constraint"),
            message = Reflect.get(error, "message");
          console.error(
            JSON.stringify({
              fixture: "winner-gas-financial-source-statement-refusal",
              statementLabel: label(text.trimStart()),
              sqlState: typeof code === "string" && /^[A-Z0-9]{5}$/u.test(code) ? code : null,
              constraint:
                typeof constraint === "string" && /^[a-z][a-z0-9_]{0,199}$/u.test(constraint)
                  ? constraint
                  : null,
              message:
                typeof message === "string" && messages.has(message)
                  ? message
                  : "non-whitelisted message redacted",
            }),
          );
        }
        throw error;
      }
    },
  };
};
