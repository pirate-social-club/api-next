import { Schema } from "effect";
import { moderatedDanceReplayDigests } from "./moderated-dance-normalization.ts";
import { hmac } from "./r2-upload-signing.ts";

type Call = (label: string, sql: string, values: readonly unknown[]) => Promise<unknown>;
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(192));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Work = Schema.Struct({
  choreographyId: Id,
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  scope: Id,
  normalizationHash: Hash,
  sourceSha256: Hash,
  frames: Schema.Array(Hash).check(Schema.isMinLength(1), Schema.isMaxLength(3600)),
  epoch: Id,
  token: Id,
});

/** Only the existing purpose-specific configured keyring is consumed. A
 * malformed ring never becomes an empty, newly generated or shared secret. */
export function decodeModeratedDanceReplayKeys(value: string): ReadonlyMap<string, Uint8Array> {
  try {
    const encoded = Schema.decodeUnknownSync(
      Schema.Record(Id, Schema.String.check(Schema.isMaxLength(512))),
    )(JSON.parse(value));
    const entries = Object.entries(encoded);
    if (entries.length < 1 || entries.length > 32)
      throw new Error("Private replay keyring unavailable");
    const keys = new Map<string, Uint8Array>();
    for (const [epoch, data] of entries) {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      if (bytes.length < 32 || bytes.length > 256)
        throw new Error("Private replay keyring unavailable");
      keys.set(epoch, bytes);
    }
    return keys;
  } catch {
    throw new Error("Private replay keyring unavailable");
  }
}

/** A fixed-context HMAC binds each epoch to its original bytes without storing
 * the key or any recording. Relabeling a different key as an existing epoch
 * fails before matching, readiness or provider dispatch. */
export async function bindModeratedDanceReplayKeys(
  call: Call,
  keys: ReadonlyMap<string, Uint8Array>,
) {
  const identities: Array<{ epoch: string; commitment: string }> = [];
  if (keys.size < 1 || keys.size > 32) throw new Error("Private replay keyring unavailable");
  for (const [epoch, bytes] of keys) {
    Schema.decodeUnknownSync(Id)(epoch);
    if (bytes.length < 32 || bytes.length > 256)
      throw new Error("Private replay keyring unavailable");
    const commitment = Array.from(
      await hmac(bytes, JSON.stringify(["pirate.private-dance-replay-key.v1", epoch])),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    identities.push({ epoch, commitment });
  }
  await call(
    "dance.replay.keys.bind",
    "SELECT bind_moderated_dance_replay_keys_v1($1::jsonb) AS packet",
    [JSON.stringify(identities)],
  );
}

/** One leased, deterministic PUBLIC descriptor per invocation. No private
 * recording is read, retained or sent to a provider for key rotation. Unknown
 * commit outcomes escape; the next invocation obtains a new bounded lease. */
export function makeModeratedDancePublicReplay(
  input: Readonly<{
    call: Call;
    keys: ReadonlyMap<string, Uint8Array>;
    randomId?: (() => string) | undefined;
  }>,
) {
  return {
    async run() {
      await bindModeratedDanceReplayKeys(input.call, input.keys);
      const token = (input.randomId ?? (() => crypto.randomUUID()))();
      const raw = await input.call(
        "dance.replay.public.claim",
        "SELECT claim_moderated_dance_public_reindex_v1($1,$2::jsonb) AS packet",
        [token, JSON.stringify([...input.keys.keys()])],
      );
      if (raw === null) return { outcome: "empty" as const };
      const work = Schema.decodeUnknownSync(Work, { onExcessProperty: "error" })(raw);
      const key = input.keys.get(work.epoch);
      if (key === undefined || work.token !== token)
        throw new Error("Public replay lease unavailable");
      const digests = await moderatedDanceReplayDigests({
        scope: work.scope,
        sourceSha256: work.sourceSha256,
        frames: work.frames,
        keys: new Map([[work.epoch, key]]),
      });
      await input.call(
        "dance.replay.public.commit",
        "SELECT finish_moderated_dance_public_reindex_v1($1,$2,$3,$4,$5::jsonb) AS packet",
        [
          work.choreographyId,
          work.revision,
          work.epoch,
          work.token,
          JSON.stringify(digests.claims),
        ],
      );
      return { outcome: "indexed" as const };
    },
  };
}
