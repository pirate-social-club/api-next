import { Schema } from "effect";

/** Only a SQLSTATE and an internal stage may leave the executor on failure.
 * Driver messages, provider bodies, URLs and credentials are never retained. */
export class KaraokeReleaseFailure extends Error {
  readonly sqlstate: string | null;
  constructor(
    readonly stage: string,
    error: unknown,
  ) {
    super("karaoke_release_effect_unproven");
    const code = Schema.decodeUnknownOption(
      Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[0-9A-Z]{5}$/u)) }),
    )(error);
    this.sqlstate = code._tag === "Some" ? code.value.code : null;
  }
}
