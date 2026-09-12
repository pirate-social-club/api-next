import {
  type BeginProviderStageResult,
  type ProviderStageInput,
  TelegramFailure,
  type TelegramStore,
} from "@pirate/application/telegram";
import type { TelegramDatabase } from "./telegram-database.ts";

type StageRow = {
  state: string;
  result: unknown;
  attempt: unknown;
};

export function makeTelegramStageStore(
  db: TelegramDatabase,
): Pick<TelegramStore, "beginProviderStage" | "completeProviderStage" | "failProviderStage"> {
  return {
    beginProviderStage(input) {
      return db.transaction(async (query): Promise<BeginProviderStageResult> => {
        const inserted = await query(
          `INSERT INTO community_telegram_provider_stages(community_id,bot_epoch,inbox_id,stage,request_hash,attempt,state)
          VALUES($1,$2,$3,$4,$5,$6,'issued') ON CONFLICT DO NOTHING RETURNING state`,
          [
            input.communityId,
            input.epoch,
            input.inboxId,
            input.stage,
            input.requestHash,
            input.attempt,
          ],
        );
        if (inserted.length > 0) return { kind: "issued" };
        const rows = await query(
          `SELECT state,result,attempt FROM community_telegram_provider_stages
          WHERE community_id=$1 AND bot_epoch=$2 AND inbox_id=$3 AND stage=$4 FOR UPDATE`,
          [input.communityId, input.epoch, input.inboxId, input.stage],
        );
        const row = rows[0] as StageRow | undefined;
        if (!row) throw new TelegramFailure({ reason: "unavailable" });
        if (row.state === "completed") return { kind: "completed", result: String(row.result) };
        // An attempt already issued this stage. Its provider outcome is
        // unknowable from here, so it is never re-issued automatically.
        if (row.state !== "failed") return { kind: "uncertain" };
        await query(
          `UPDATE community_telegram_provider_stages
          SET state='issued',request_hash=$5,attempt=$6,error=NULL,issued_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE community_id=$1 AND bot_epoch=$2 AND inbox_id=$3 AND stage=$4`,
          [
            input.communityId,
            input.epoch,
            input.inboxId,
            input.stage,
            input.requestHash,
            input.attempt,
          ],
        );
        return { kind: "issued" };
      });
    },
    async completeProviderStage(input) {
      await db.query(
        `UPDATE community_telegram_provider_stages
        SET state='completed',result=$6,error=NULL,updated_at=clock_timestamp()
        WHERE community_id=$1 AND bot_epoch=$2 AND inbox_id=$3 AND stage=$4 AND attempt=$5 AND state='issued'`,
        [input.communityId, input.epoch, input.inboxId, input.stage, input.attempt, input.result],
      );
    },
    async failProviderStage(input) {
      await db.query(
        `UPDATE community_telegram_provider_stages
        SET state='failed',error=$6,updated_at=clock_timestamp()
        WHERE community_id=$1 AND bot_epoch=$2 AND inbox_id=$3 AND stage=$4 AND attempt=$5 AND state='issued'`,
        [input.communityId, input.epoch, input.inboxId, input.stage, input.attempt, input.error],
      );
    },
  };
}
