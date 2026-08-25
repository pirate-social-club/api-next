import type { CommunityStore } from "../../ports.ts";

export interface CommunityServices {
  readonly communityStore: CommunityStore["Service"];
}

export const isUsableId = (value: string): boolean =>
  value.length > 0 && value.trim() === value && !value.includes("\u0000");
