import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { decodeHnsAuthorityInventoryBytes } from "../../packages/application/src/namespace-ownership/hns-authority-inventory.ts";
import { deriveCanonicalHnsAuthorityZoneBytesV1 } from "../../packages/hns-dns-runtime/src/dns-axfr-zone.ts";
import { exchangeDirectHnsDnsTsigAxfrV1 } from "../../packages/hns-dns-runtime/src/dns-tsig-axfr.ts";
import { ContinuityRefusal } from "./refusal.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const quote = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

async function bounded(stream, maximum) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > maximum)
      throw new ContinuityRefusal("Operator transport response exceeded its limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function execute(args, maximum = 4 * 1024 * 1024) {
  const child = Bun.spawn(args, {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  const stopChild = () => child.kill();
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  try {
    const [output, , code] = await Promise.all([
      bounded(child.stdout, maximum),
      bounded(child.stderr, 64 * 1024),
      child.exited,
    ]);
    if (code !== 0)
      throw new ContinuityRefusal("Operator transport failed; no credential output retained");
    return output;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stopChild);
    process.removeListener("SIGTERM", stopChild);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string")
    throw new ContinuityRefusal("Local port unavailable");
  return address.port;
}

export async function verifyAuthorityProof(directory, replay = false, python = "python3") {
  await execute([
    python,
    fileURLToPath(new URL("./verify-authorities.py", import.meta.url)),
    directory,
    ...(replay ? ["--replay"] : []),
  ]);
}

export async function acquireContinuityEvidence({ directory, state, sshHost, python = "python3" }) {
  if (!/^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/u.test(sshHost))
    throw new ContinuityRefusal("Invalid SSH host");
  const root = state.dns.canonical_root;
  const inventory = await decodeHnsAuthorityInventoryBytes(
    Buffer.from(state.inventory.bytes_hex, "hex"),
  );
  const endpoints = inventory.inventory.authoritative_nameserver_glue.filter(
    (entry) => entry.active,
  );
  if (
    endpoints.length !== 2 ||
    endpoints.some((entry) => entry.authority_address_family !== "GLUE4")
  )
    throw new ContinuityRefusal("This ceremony requires two IPv4 authorities");
  const authorities = [];
  for (const endpoint of endpoints) {
    authorities.push({
      address: endpoint.authority_address,
      nameserver: endpoint.authority_nameserver,
      dns_port: await availablePort(),
    });
  }
  const gatewayPort = await availablePort();
  const transport = { authorities, gateway_port: gatewayPort };
  await Bun.write(`${directory}/transport.json`, JSON.stringify(transport));

  async function rpc(method, params) {
    const request = JSON.stringify({ method, params });
    const code = `const http=require('http'),fs=require('fs');const key=fs.readFileSync(process.env.HSD_API_KEY_FILE,'utf8').trim();const q=http.request({host:'127.0.0.1',port:12037,method:'POST',auth:'x:'+key,headers:{'Content-Type':'application/json'}},r=>{r.pipe(process.stdout);if(r.statusCode!==200)process.exitCode=1});q.on('error',()=>{process.exitCode=1});q.setTimeout(10000,()=>q.destroy());q.end(${JSON.stringify(request)});`;
    const raw = (
      await execute([
        "ssh",
        ...sshOptions,
        sshHost,
        `sudo -n docker exec pirate-hsd-observer node -e ${quote(code)}`,
      ])
    ).toString();
    const decoded = JSON.parse(raw);
    if (decoded.error !== null || decoded.result === null)
      throw new ContinuityRefusal("HSD observation refused");
    return { request, raw, result: decoded.result };
  }
  const rows = [];
  async function retain(ref, method, params) {
    const response = await rpc(method, params);
    rows.push({ ref, ...response });
    return response.result;
  }
  const before = await retain("getblockchaininfo:before", "getblockchaininfo", []);
  await retain("getblockheader:tip-before", "getblockheader", [before.bestblockhash, true]);
  await retain("getblockheader:genesis", "getblockheader", [
    "5b6ef2d3c1f3cdcadfd9a030ba1811efdd17740f14e166489760741d075992e0",
    true,
  ]);
  await retain(`getnameinfo:${root}`, "getnameinfo", [root, false]);
  await retain(`getnameresource:${root}`, "getnameresource", [root, false]);
  await retain("getnameresource:pirate", "getnameresource", ["pirate", false]);
  const after = await retain("getblockchaininfo:after", "getblockchaininfo", []);
  await retain("getblockheader:tip-after", "getblockheader", [after.bestblockhash, true]);
  if (before.bestblockhash !== after.bestblockhash)
    throw new ContinuityRefusal("HSD tip moved; acquire a new observation");
  await Bun.write(
    `${directory}/chain.json`,
    JSON.stringify({ observed_at: new Date().toISOString(), rows }),
  );

  const tunnel = Bun.spawn(
    [
      "ssh",
      ...sshOptions,
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      ...authorities.flatMap((entry) => ["-L", `127.0.0.1:${entry.dns_port}:${entry.address}:53`]),
      "-L",
      `127.0.0.1:${gatewayPort}:${authorities[0].address}:443`,
      sshHost,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  const stopTunnel = () => tunnel.kill();
  process.once("SIGINT", stopTunnel);
  process.once("SIGTERM", stopTunnel);
  let secret;
  try {
    await Bun.sleep(1500);
    if (tunnel.exitCode !== null) throw new ContinuityRefusal("Authority tunnel failed");
    const listing = await execute(
      [
        "ssh",
        ...sshOptions,
        sshHost,
        "sudo -n docker exec pirate-hns-authdns pdnsutil tsigkey list",
      ],
      64 * 1024,
    );
    const line = listing
      .toString()
      .split("\n")
      .find((entry) => entry.trim().split(/\s+/u)[0]?.replace(/\.$/u, "") === "pirate-axfr");
    const fields = line?.trim().split(/\s+/u);
    if (fields?.[1]?.replace(/\.$/u, "") !== "hmac-sha256" || fields[2] === undefined)
      throw new ContinuityRefusal("TSIG credential unavailable");
    secret = Buffer.from(fields[2], "base64");
    listing.fill(0);
    if (secret.length < 16 || secret.length > 512)
      throw new ContinuityRefusal("TSIG credential length invalid");
    for (const [index, authority] of authorities.entries()) {
      const result = await exchangeDirectHnsDnsTsigAxfrV1({
        connector: {
          connect: (request) =>
            new Promise((resolve, reject) => {
              const socket = createConnection({
                host: "127.0.0.1",
                port: authority.dns_port,
                signal: request.signal,
              });
              socket.once("connect", () => resolve(socket));
              socket.once("error", reject);
            }),
        },
        host: "127.0.0.2",
        family: 4,
        zone_name: root,
        credential: { key_name: "pirate-axfr", algorithm: "hmac-sha256", secret_bytes: secret },
        fudge_seconds: 300,
        response_message_max_bytes: 65535,
        response_total_max_bytes: 4 * 1024 * 1024,
        response_max_messages: 1024,
        timeout_ms: 12000,
        signal: AbortSignal.timeout(15000),
      });
      const zone = deriveCanonicalHnsAuthorityZoneBytesV1({
        zone_name: root,
        response_sequence_bytes: result.response_sequence_bytes,
      });
      await Bun.write(
        `${directory}/zone-${index === 0 ? "primary" : "secondary"}.json`,
        JSON.stringify({
          observed_at: new Date().toISOString(),
          canonical_zone_bytes_hex: hex(zone),
          canonical_zone_sha256: sha(zone),
          views: [
            {
              authority_address: authority.address,
              request_hex: hex(result.request_bytes),
              response_sequence_hex: hex(result.response_sequence_bytes),
            },
          ],
        }),
      );
    }
    await verifyAuthorityProof(directory, false, python);
  } finally {
    process.removeListener("SIGINT", stopTunnel);
    process.removeListener("SIGTERM", stopTunnel);
    secret?.fill(0);
    tunnel.kill();
    await tunnel.exited;
  }
}
