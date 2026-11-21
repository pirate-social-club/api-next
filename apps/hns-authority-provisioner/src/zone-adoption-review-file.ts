import { createHash } from "node:crypto";
import { HnsZoneAdoptionRefusal } from "../../../packages/platform-cf/src/hns-zone-adoption.ts";

/** Bind a review to operator-selected bytes before decoding its typed policy. */
export async function readReviewedZoneAdoptionFile(
  read: (path: string) => Promise<Uint8Array>,
  file: Readonly<{ path: string; sha256: string }> | undefined,
  kind: "relocation" | "owner TXT",
): Promise<unknown> {
  if (file === undefined) return undefined;
  const bytes = await read(file.path);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new HnsZoneAdoptionRefusal(`the ${kind} is not the one that was reviewed`);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HnsZoneAdoptionRefusal(`the ${kind} review is not JSON`);
  }
}
