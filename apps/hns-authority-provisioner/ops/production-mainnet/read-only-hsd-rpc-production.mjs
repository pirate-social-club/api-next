import { readFile } from "node:fs/promises";
import { createReadOnlyHsdRpcProxy } from "../staging-mainnet/read-only-hsd-rpc-proxy.mjs";

const directory = process.env.CREDENTIALS_DIRECTORY;
if (!directory) throw new Error("Production HNS reader credentials are unavailable");
const portText = process.env.HNS_READER_LISTEN_PORT ?? "12039";
if (!/^[1-9][0-9]{0,4}$/u.test(portText) || Number(portText) > 65535) {
  throw new Error("Production HNS reader port is invalid");
}

const [clientKey, upstreamKey] = await Promise.all([
  readFile(`${directory}/production-hsd-client-key`, "utf8"),
  readFile(`${directory}/production-hsd-upstream-key`, "utf8"),
]);

createReadOnlyHsdRpcProxy({
  clientKey: clientKey.trim(),
  upstreamKey: upstreamKey.trim(),
}).listen(Number(portText), "127.0.0.1");
