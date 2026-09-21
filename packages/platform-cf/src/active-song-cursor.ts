import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Schema } from "effect";

const Prefix = "asm1.";
const Payload = Schema.Struct({
  v: Schema.Literal(1),
  b: Schema.String,
  t: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u)),
  s: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
    Schema.isPattern(/^[^\s\0](?:[^\0]*[^\s\0])?$/u),
  ),
});
export type ActiveSongCursor = Readonly<{ createdAt: string; submissionId: string }>;
const binding = (accountId: string, communityId: string): string =>
  createHash("sha256").update(`asm1\0${accountId}\0${communityId}`).digest("hex");

export function encodeActiveSongCursor(
  accountId: string,
  communityId: string,
  cursor: ActiveSongCursor,
): string {
  return (
    Prefix +
    Buffer.from(
      JSON.stringify({
        v: 1,
        b: binding(accountId, communityId),
        t: cursor.createdAt,
        s: cursor.submissionId,
      }),
    ).toString("base64url")
  );
}

export function decodeActiveSongCursor(
  value: string | undefined,
  accountId: string,
  communityId: string,
): ActiveSongCursor | null {
  if (value === undefined) return null;
  if (
    value.length > 1_024 ||
    !value.startsWith(Prefix) ||
    !/^[A-Za-z0-9_-]+$/u.test(value.slice(Prefix.length))
  )
    throw new Error("invalid_cursor");
  const payload = Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" })(
    JSON.parse(Buffer.from(value.slice(Prefix.length), "base64url").toString("utf8")),
  );
  if (
    payload.b !== binding(accountId, communityId) ||
    !Number.isFinite(Date.parse(payload.t)) ||
    new Date(payload.t).toISOString().slice(0, 23) !== payload.t.slice(0, 23)
  )
    throw new Error("invalid_cursor");
  return { createdAt: payload.t, submissionId: payload.s };
}
