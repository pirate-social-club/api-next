/** Read the one sealed phone source for an owner safety review. The key is
 * object-scoped and read-only; the downloaded bytes must match the database's
 * frozen digest before they are retained locally. */
import { readFile } from "node:fs/promises";
import { makeHostMediaReader, makeHostR2Transport } from "../scripts/song-video-render-host-r2.ts";

const reference = "media://immutable/media-operation-04ec0406-d10b-4024-80ed-84808007f265/video/1";
const expectedSha256 = "201c60699ffdf40a0fb65652f0af93c6de13795df8457979cac6e9c74a8b9027";
const credentialPath = `${process.env.QUAL_PRIVATE_DIR ?? ""}/review.json`;
const outputPath = process.env.PHONE_REVIEW_OUTPUT;
if (!process.env.QUAL_PRIVATE_DIR || !outputPath) throw new Error("review paths required");
const credentials = JSON.parse(await readFile(credentialPath, "utf8")) as {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};
const transport = makeHostR2Transport({
  accountId: "08a4c22cf52e2ecae883e36f80a33f4a",
  credentials: {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  },
});
const source = await makeHostMediaReader({
  transport,
  bucket: "pirate-media-immutable-staging",
}).read(reference);
const actualSha256 = Buffer.from(
  await crypto.subtle.digest("SHA-256", source as Uint8Array<ArrayBuffer>),
).toString("hex");
if (actualSha256 !== expectedSha256) throw new Error("phone source digest mismatch");
await Bun.write(outputPath, source);
console.log(JSON.stringify({ reference, bytes: source.byteLength, sha256: actualSha256 }));
