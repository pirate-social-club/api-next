import { readFile } from "node:fs/promises";
import { createReadOnlyHsdRpcProxy } from "../staging-mainnet/read-only-hsd-rpc-proxy.mjs";

const directory = process.env.CREDENTIALS_DIRECTORY;
if (!directory) throw new Error("Production HNS reader credentials are unavailable");

const [clientKey, upstreamKey] = await Promise.all([
  readFile(`${directory}/production-hsd-client-key`, "utf8"),
  readFile(`${directory}/production-hsd-upstream-key`, "utf8"),
]);

createReadOnlyHsdRpcProxy({
  clientKey: clientKey.trim(),
  upstreamKey: upstreamKey.trim(),
}).listen(12039, "127.0.0.1");
