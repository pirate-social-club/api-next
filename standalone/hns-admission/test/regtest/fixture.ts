import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
export const IMAGE =
  "sha256:7a9aca3e77d828f23bf78a76daefcf2d9c718b2215a5ff083e10b998917ecc1f";
export function docker(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}
export class NodeFixture {
  readonly name = "hns-admission-" + randomUUID();
  start(network = "none") {
    docker(
      "run",
      "--detach",
      "--name",
      this.name,
      "--network",
      network,
      IMAGE,
      "hsd",
      "--network=regtest",
      "--http-host=0.0.0.0",
      "--api-key=controlled-progression",
      "--index-tx",
      "--index-address",
      "--listen",
      "--host=0.0.0.0",
    );
  }
  close() {
    docker("rm", "--force", this.name);
  }
  async ready() {
    for (let i = 0; i < 50; i++) {
      try {
        const info = this.rpc("getblockchaininfo") as { chain: string };
        if (info.chain !== "regtest") throw new Error("wrong_chain");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("regtest_not_ready");
  }
  rpc(method: string, params: unknown[] = [], wallet = false): unknown {
    const code =
      "(async()=>{const r=await fetch('http://127.0.0.1:" +
      (wallet ? 14039 : 14037) +
      "/',{method:'POST',headers:{authorization:'Basic '+Buffer.from('x:controlled-progression').toString('base64'),'content-type':'application/json'},body:JSON.stringify(" +
      JSON.stringify({ method, params, id: 1 }) +
      ")});const b=await r.json();if(b.error)throw Error(JSON.stringify(b.error));console.log(JSON.stringify(b.result));})().catch(e=>{console.error(e.message);process.exitCode=1})";
    return JSON.parse(docker("exec", this.name, "node", "-e", code));
  }
  encode(records: unknown[]) {
    return docker(
      "exec",
      this.name,
      "node",
      "-e",
      "console.log(require('/usr/local/lib/node_modules/hsd/lib/dns/resource').Resource.fromJSON(" +
        JSON.stringify({ records }) +
        ").encode().toString('hex'))",
    );
  }
  async acquire(name: string) {
    const address = this.rpc("getnewaddress", [], true);
    const mine = (count: number) =>
      this.rpc("generatetoaddress", [count, address]);
    mine(110);
    this.rpc("sendopen", [name], true);
    mine(8);
    this.rpc("sendbid", [name, 5, 10], true);
    mine(6);
    this.rpc("sendreveal", [name], true);
    mine(11);
    return mine;
  }
}
