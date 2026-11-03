import { Effect } from "effect";
import type { makeControlPlaneSharedSongContextProducer } from "../../../packages/platform-cf/src/shared-song-megapot-production.ts";
import type { makeSongMegapotFundingRecovery } from "./song-megapot-funding-recovery.ts";

type Recovery = ReturnType<typeof makeSongMegapotFundingRecovery>;
type Contexts = ReturnType<typeof makeControlPlaneSharedSongContextProducer>;

/** The serving funding stage. Existing receipt and finality recovery takes
 * priority over one bounded batch of prospective quotes. Tests compose this
 * same function so the joint job is exercised with its real quote producer. */
export function composeSongFundingStage(
  recovery: Pick<Recovery, "run">,
  contexts: Pick<Contexts, "run">,
) {
  return Effect.fn("SongFundingRuntime.run")(function* (options: Parameters<Recovery["run"]>[0]) {
    if (!options.enabled) return;
    yield* recovery.run(options);
    yield* contexts.run({ enabled: true, ensure: options.ensure, limit: 6 });
  });
}
