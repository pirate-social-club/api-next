import { canonicalJson } from "../canonical-json.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";

export const WALLET_SEND_ACTION_KIND = "wallet_send" as const;

export function walletSendActionPayloadHash(accountId: string, personaId: string): string {
  return sha256Hex(
    canonicalJson({
      action_kind: WALLET_SEND_ACTION_KIND,
      account_id: accountId,
      persona_id: personaId,
      version: 1,
    }),
  );
}

export function walletSendIntentBindingHash(accountId: string, personaId: string): string {
  return sha256Hex(
    canonicalJson({
      action_kind: WALLET_SEND_ACTION_KIND,
      actor_id: accountId,
      persona_id: personaId,
      binding: "wallet_send_very_v1",
    }),
  );
}
