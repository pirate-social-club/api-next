// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectId, ExecutionContext } from "@cloudflare/workers-types";
import {
  decodeKaraokeResetCommand,
  type KaraokeResetReceipt,
} from "./karaoke-reset-installation.ts";
import {
  admitKaraokeResetOperator,
  type KaraokeResetOperatorBindings,
} from "./karaoke-reset-operator-auth.ts";

interface Bindings extends KaraokeResetOperatorBindings {
  readonly KARAOKE_ATTEMPT: {
    idFromString(value: string): DurableObjectId;
    get(id: DurableObjectId): {
      applyReset(assertion: string, command: unknown): Promise<KaraokeResetReceipt>;
    };
  };
}

/** Named service-binding entrypoint only. No HTTP route or ordinary cron dispatch. */
export class KaraokeResetOperatorEntrypoint extends WorkerEntrypoint<Bindings> {
  private readonly runtimeEnv: Bindings;

  constructor(ctx: ExecutionContext, env: Bindings) {
    super(ctx, env);
    this.runtimeEnv = env;
  }

  async apply(assertion: string, input: unknown): Promise<KaraokeResetReceipt> {
    await admitKaraokeResetOperator(this.runtimeEnv, assertion);
    const command = decodeKaraokeResetCommand(input);
    const id = this.runtimeEnv.KARAOKE_ATTEMPT.idFromString(command.objectId);
    return this.runtimeEnv.KARAOKE_ATTEMPT.get(id).applyReset(assertion, command);
  }
}
