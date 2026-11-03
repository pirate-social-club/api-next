export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const bytes = (hex) => Buffer.from(hex, "hex");
export const digest = (value) => sha(JSON.stringify(value));
export const fail = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const reference = (manifest) => `hns-community-app-handle-gateway-sha256:${sha(manifest)}`;
export const stateIdentity = ({ database_time: _, ...state }) => digest(state);

import { createHash } from "node:crypto";
