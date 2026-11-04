import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const HOST = "ubuntu@94.103.168.209";
const TARGET = "/opt/pirate-hns-staging/journey-chain.js";
const SHA256 = /^[0-9a-f]{64}$/u;
const SSH_OPTIONS = [
  "-F",
  "/dev/null",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

export type InstallTransport = (command: string, input: Uint8Array) => Promise<string>;

/** Only fixed, bounded host output is returned; stderr is never exposed. */
export const stagingInstallTransport: InstallTransport = (command, input) =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_OPTIONS, HOST, command], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024) {
        failed = true;
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stdin.on("error", () => {
      failed = true;
      child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Staging runner install transport failed; inspect target before retry."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0)
        reject(new Error("Staging runner install outcome uncertain; inspect target before retry."));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.end(input);
  });

const preflight = [
  "set -eu",
  `if sudo test -L ${TARGET}; then printf symlink`,
  `elif sudo test -e ${TARGET}; then sudo sha256sum ${TARGET}`,
  "else printf absent; fi",
].join("; ");

function installCommand(expectedSha256: string) {
  return [
    "set -eu",
    "umask 077",
    "sudo install -d -m 0755 /opt/pirate-hns-staging",
    `if sudo test -e ${TARGET} || sudo test -L ${TARGET}; then exit 21; fi`,
    "tmp=$(sudo mktemp /opt/pirate-hns-staging/.journey-chain-XXXXXXXXXX)",
    "trap 'sudo rm -f \"$tmp\"' EXIT",
    'sudo tee "$tmp" >/dev/null',
    `test "$(sudo sha256sum "$tmp" | cut -d' ' -f1)" = ${expectedSha256}`,
    'sudo chown root:root "$tmp"',
    'sudo chmod 0555 "$tmp"',
    `sudo mv -n "$tmp" ${TARGET}`,
    `test "$(sudo sha256sum ${TARGET} | cut -d' ' -f1)" = ${expectedSha256}`,
    "printf installed",
  ].join("; ");
}

export async function installJourneyChain(
  bundlePath: string,
  expectedSha256: string,
  executeHost = false,
  transport: InstallTransport = stagingInstallTransport,
) {
  if (!isAbsolute(bundlePath) || !SHA256.test(expectedSha256))
    throw new Error("Reviewed absolute bundle path and SHA-256 are required.");
  const metadata = await lstat(bundlePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_777_216)
    throw new Error("Staging journey bundle must be a bounded regular file.");
  const bytes = await readFile(bundlePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
    throw new Error("Staging journey bundle differs from its reviewed digest.");
  if (!executeHost)
    return { outcome: "dry_run", host: HOST, target: TARGET, bundle_sha256: expectedSha256 };
  const existing = await transport(preflight, new Uint8Array());
  if (existing === "symlink")
    throw new Error("Staging journey target is a symlink; no install attempted.");
  if (existing === `${expectedSha256}  ${TARGET}`)
    return {
      outcome: "already_installed",
      host: HOST,
      target: TARGET,
      bundle_sha256: expectedSha256,
    };
  if (existing !== "absent")
    throw new Error("Staging journey target differs; no replacement attempted.");
  const installed = await transport(installCommand(expectedSha256), bytes);
  if (installed !== "installed")
    throw new Error("Staging runner install receipt uncertain; inspect target before retry.");
  const readback = await transport(preflight, new Uint8Array());
  if (readback !== `${expectedSha256}  ${TARGET}`)
    throw new Error("Staging journey target readback differs; stop before use.");
  return { outcome: "installed", host: HOST, target: TARGET, bundle_sha256: expectedSha256 };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const [bundleOption, bundlePath, digestOption, expectedSha256, executeOption] = args;
  if (
    (args.length !== 4 && args.length !== 5) ||
    bundleOption !== "--bundle" ||
    !bundlePath ||
    digestOption !== "--expected-sha256" ||
    !expectedSha256 ||
    (args.length === 5 && executeOption !== "--execute-host")
  )
    throw new Error(
      "usage: bun install-journey-chain.ts --bundle ABS --expected-sha256 HEX [--execute-host]",
    );
  console.log(
    JSON.stringify(await installJourneyChain(bundlePath, expectedSha256, args.length === 5)),
  );
}
