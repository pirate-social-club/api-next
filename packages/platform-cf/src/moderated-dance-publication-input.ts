import { Schema } from "effect";
import { prepareDancePublicationInput } from "../../application/src/use-cases/dance/publication-input.ts";

const Saved = Schema.Struct({
  state: Schema.Literals(["preparing", "stored", "adopted", "cleanup", "cleaned"]),
  token: Schema.NonEmptyString,
  receipt: Schema.NullOr(Schema.Unknown),
});

/** The media processor's private database protocol. A caller must await each
 * committed grant before I/O. Lost put acknowledgements recover through HEAD,
 * never another put. No public handler or browser session is manufactured. */
export function makeModeratedDancePublicationInput(
  deps: Readonly<{
    call: (label: string, sql: string, values: readonly unknown[]) => Promise<unknown>;
    reviewId: string;
    token: string;
    videoTrackEnabled: boolean;
  }>,
) {
  const command = (action: string, fields: Readonly<Record<string, unknown>> = {}) =>
    deps.call(
      `dance-publication.${action}`,
      "SELECT moderated_dance_publication_input_v1($1,$2,$3::jsonb) packet",
      [
        deps.reviewId,
        action,
        JSON.stringify({ ...fields, token: deps.token, videoTrackEnabled: deps.videoTrackEnabled }),
      ],
    );
  return {
    begin: () => command("begin"),
    plan: (body: unknown) => command("plan", { body }),
    put: () => command("put"),
    observe: (body: unknown) => command("observe", { body }),
    cleanup: () => command("cleanup"),
    abandon: () => command("abandon"),
    cleaned: () => command("cleaned", { keyFenced: true }),
    adopt: async () => {
      const raw = await command("inspect");
      if (raw !== null && raw !== undefined) {
        const saved = Schema.decodeUnknownSync(Saved)(raw);
        if (saved.token !== deps.token) throw new Error("Dance publication input token changed");
        if (saved.state === "adopted") return saved.receipt;
      }
      const prepared = prepareDancePublicationInput(await command("packet"));
      return command("adopt", { prepared });
    },
  };
}
