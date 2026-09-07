// biome-ignore lint/suspicious/noTsIgnore: cloudflare:workers exists only in the Workers runtime
// @ts-ignore cloudflare:workers exists only in the Workers runtime
import { WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectId, ExecutionContext } from "@cloudflare/workers-types";
import type { KaraokeResetSnapshot } from "./karaoke-reset-inspection.ts";
import {
  decodeKaraokeResetCommand,
  decodeKaraokeResetTarget,
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
      inspectReset(assertion: string, target: unknown): Promise<KaraokeResetSnapshot>;
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

  async inspect(assertion: string, input: unknown): Promise<KaraokeResetSnapshot> {
    await admitKaraokeResetOperator(this.runtimeEnv, assertion);
    const target = decodeKaraokeResetTarget(input);
    const id = this.runtimeEnv.KARAOKE_ATTEMPT.idFromString(target.objectId);
    return this.runtimeEnv.KARAOKE_ATTEMPT.get(id).inspectReset(assertion, target);
  }
}
