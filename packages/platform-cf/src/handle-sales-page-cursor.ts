import { createHash } from "node:crypto";
import { HandleSalesPageRejected } from "@pirate/application";

type HandlePageOperation =
  | "activations"
  | "offerings"
  | "management_activations"
  | "management_offerings"
  | "persona_grants";
type HandlePageCursor = Readonly<{
  snapshotCutoff: string;
  sortTime: string;
  sortId: string;
}>;

const pageRejected = (reason: HandleSalesPageRejected["reason"]): HandleSalesPageRejected =>
  new HandleSalesPageRejected({ reason });

const base64UrlEncode = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const base64UrlDecode = (value: string): string => {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};

const pageScope = (operation: HandlePageOperation, scope: string): string =>
  createHash("sha256")
    .update(JSON.stringify([operation, scope]))
    .digest("hex")
    .slice(0, 32);

export const encodePageCursor = (
  operation: HandlePageOperation,
  scope: string,
  cursor: HandlePageCursor,
): string => {
  const encoded = `hcp1.${base64UrlEncode(
    JSON.stringify([
      operation,
      pageScope(operation, scope),
      Date.parse(cursor.snapshotCutoff),
      Date.parse(cursor.sortTime),
      cursor.sortId,
    ]),
  )}`;
  if (encoded.length > 256) throw pageRejected("invalid_cursor");
  return encoded;
};

export const decodePageCursor = (
  value: string | undefined,
  operation: HandlePageOperation,
  scope: string,
): HandlePageCursor | null => {
  if (value === undefined) return null;
  if (!value.startsWith("hcp1.")) throw pageRejected("invalid_cursor");
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(value.slice(5)));
    if (!Array.isArray(parsed) || parsed.length !== 5) throw pageRejected("invalid_cursor");
    const [storedOperation, storedScope, snapshotMillis, sortMillis, sortId] = parsed;
    if (
      storedOperation !== operation ||
      storedScope !== pageScope(operation, scope) ||
      typeof snapshotMillis !== "number" ||
      !Number.isSafeInteger(snapshotMillis) ||
      snapshotMillis <= 0 ||
      typeof sortMillis !== "number" ||
      !Number.isSafeInteger(sortMillis) ||
      sortMillis <= 0 ||
      sortMillis > snapshotMillis ||
      typeof sortId !== "string" ||
      sortId.length === 0 ||
      sortId.length > 128 ||
      sortId !== sortId.trim() ||
      [...sortId].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw pageRejected("invalid_cursor");
    }
    return {
      snapshotCutoff: new Date(snapshotMillis).toISOString(),
      sortTime: new Date(sortMillis).toISOString(),
      sortId,
    };
  } catch (error) {
    if (error instanceof HandleSalesPageRejected) throw error;
    throw pageRejected("invalid_cursor");
  }
};

export const pageLimit = (value: number | undefined): number => {
  const resolved = value ?? 20;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw pageRejected("invalid_limit");
  }
  return resolved;
};
