import { spawn } from "node:child_process";
import { Schema } from "effect";
import { reconciliationDigest } from "../packages/platform-cf/src/karaoke-reconciliation-evidence.ts";
import {
  decodeReconciliation,
  ReconciliationDigest,
} from "../packages/platform-cf/src/karaoke-reconciliation-schema.ts";

export const STAGING_EXTERNAL_HOSTS = [
  "94.103.168.161",
  "81.15.150.159",
  "94.103.168.209",
] as const;
export const ExternalProducerPin = Schema.Struct({
  host: Schema.Literals(STAGING_EXTERNAL_HOSTS),
  // Pin is independently reviewed after destination/source classification. It
  // cannot be generated and accepted by this readback in the same operation.
  expectedSnapshotDigest: ReconciliationDigest,
  heldUnits: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_@.-]+\.service$/u)),
  ).check(Schema.isMaxLength(512)),
  codeFiles: Schema.Array(
    Schema.String.check(Schema.isPattern(/^\/[a-zA-Z0-9_./@+-]{1,511}$/u)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});

// Remote program emits hashes and non-secret unit states only. Provider paths,
// environment contents, command lines and credentials never leave the host.
const program = String.raw`
import hashlib, json, os, re, signal, stat, subprocess
signal.alarm(15)
def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3).stdout

def digest(data):
    return hashlib.sha256(data).hexdigest()

file_cache = {}
def file_hash(path, maximum=16777216):
    with open(path, 'rb') as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum: raise ValueError()
        identity = (before.st_ino,before.st_dev,before.st_size,before.st_mtime_ns,before.st_ctime_ns)
        if identity in file_cache: return file_cache[identity]
        value = hashlib.sha256()
        for block in iter(lambda: handle.read(65536), b''): value.update(block)
        after = os.fstat(handle.fileno())
        if (before.st_ino,before.st_dev,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_ino,after.st_dev,after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ValueError()
        file_cache[identity] = value.hexdigest()
        return value.hexdigest()

def selected(name):
    return name.endswith('.service') and (name.startswith('pirate-') or name == 'zkpassport-verifier.service')

def inventory():
    files = json.loads(run(['systemctl','list-unit-files','--type=service','--output=json','--no-pager']))
    loaded = json.loads(run(['systemctl','list-units','--all','--type=service','--output=json','--no-pager']))
    names = sorted(set([r['unit_file'] for r in files if selected(r['unit_file'])] + [r['unit'] for r in loaded if selected(r['unit'])]))
    if not names or len(names) > 512: raise ValueError()
    return names

def unit(name):
    fields = ['MainPID','ActiveState','SubState','UnitFileState','ControlGroup','FragmentPath','DropInPaths','EnvironmentFiles']
    def properties():
        data = run(['systemctl','show',name,'--no-pager'] + ['--property='+field for field in fields]).decode()
        return dict(line.split('=',1) for line in data.splitlines())
    before = properties()
    pid = int(before['MainPID'])
    # Hash systemd's merged unit including inline environment privately.
    merged = b'masked' if before['UnitFileState'] in ['masked','masked-runtime'] else run(['systemctl','cat',name,'--no-pager'])
    env_text = before['EnvironmentFiles']
    pattern = r'(\S+) \(ignore_errors=(?:yes|no)\)'
    env_files = re.findall(pattern, env_text)
    if re.sub(pattern, '', env_text).strip(): raise ValueError()
    env_hashes = []
    for path in env_files:
        if not path.startswith('/') or any(c in path for c in [' ', '*', '?']): raise ValueError()
        env_hashes.append(file_hash(path))
    process_hash = None
    if pid:
        base = '/proc/'+str(pid)
        cgroup = open(base+'/cgroup','rb').read()
        expected = before['ControlGroup'].encode()
        if not expected or not any(line.split(b':',2)[-1] == expected for line in cgroup.splitlines()): raise ValueError()
        env = open(base+'/environ','rb').read(1048577)
        cmd = open(base+'/cmdline','rb').read(65537)
        if len(env)>1048576 or len(cmd)>65536: raise ValueError()
        process_hash = digest(b'\0'.join(sorted(env.split(b'\0'))) + b'\0' + cmd + b'\0' + file_hash(base+'/exe',268435456).encode() + b'\0' + os.readlink(base+'/cwd').encode())
    residual = 0
    for item in os.scandir('/proc'):
        if not item.name.isdigit(): continue
        try:
            groups = open(item.path+'/cgroup','rb').read(65537)
        except FileNotFoundError:
            continue
        if len(groups) > 65536: raise ValueError()
        suffix = ('/'+name).encode()
        if any(line.split(b':',2)[-1].endswith(suffix) or suffix+b'/' in line.split(b':',2)[-1] for line in groups.splitlines()): residual += 1
    if before != properties(): raise ValueError()
    return {'unit':name,'active':before['ActiveState'],'sub':before['SubState'],
      'enabled':before['UnitFileState'],'processPresent':bool(pid),'residualProcesses':residual,
      'unitDigest':digest(merged),'environmentDigests':env_hashes,'processDigest':process_hash}

try:
    names = inventory()
    units = [unit(name) for name in names]
    code = [{'pathDigest':digest(path.encode()),'contentDigest':file_hash(path)} for path in CONFIG['codeFiles']]
    if names != inventory(): raise ValueError()
    print(json.dumps({'version':'staging-external-snapshot-v1','units':units,'code':code},sort_keys=True,separators=(',',':')))
except Exception:
    raise SystemExit(1)
`;

export async function readStagingExternalSnapshot(
  pin: typeof ExternalProducerPin.Type,
): Promise<string> {
  const config = decodeReconciliation(ExternalProducerPin, pin);
  const encoded = Buffer.from(JSON.stringify({ codeFiles: config.codeFiles })).toString("base64");
  const script = `import base64, json\nCONFIG=json.loads(base64.b64decode('${encoded}'))\n${program}`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=3",
        "-o",
        "ServerAliveInterval=3",
        "-o",
        "ServerAliveCountMax=1",
        `ubuntu@${config.host}`,
        "sudo",
        "-n",
        "python3",
        "-",
      ],
      {
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = Buffer.alloc(0);
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.byteLength + chunk.byteLength > 262_144) {
        failed = true;
        child.kill("SIGKILL");
      } else output = Buffer.concat([output, chunk]);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("external_snapshot_unproven"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("external_snapshot_unproven"));
      else {
        try {
          resolve(new TextDecoder("utf8", { fatal: true }).decode(output).trim());
        } catch {
          reject(new Error("external_snapshot_unproven"));
        }
      }
    });
    child.stdin.on("error", () => {
      failed = true;
    });
    child.stdin.end(script);
  });
}

/** Source/destination-reviewed snapshots only. No stop/restart and no newly
 * observed digest can authorize itself. All three inventoried hosts are required.
 */
export async function collectStagingExternalProducers(input: {
  readonly pins: readonly (typeof ExternalProducerPin.Type)[];
  readonly readSnapshot?: typeof readStagingExternalSnapshot;
}) {
  const pins = decodeReconciliation(Schema.Array(ExternalProducerPin), input.pins);
  if (
    pins.length !== 3 ||
    [...pins.map((pin) => pin.host)].sort().join() !== [...STAGING_EXTERNAL_HOSTS].sort().join()
  )
    throw new Error("external_inventory_incomplete");
  const observations = await Promise.all(
    pins.map(async (pin) => {
      if (pin.host === "94.103.168.209" && !pin.heldUnits.includes("zkpassport-verifier.service"))
        throw new Error("external_held_inventory_incomplete");
      const first = await (input.readSnapshot ?? readStagingExternalSnapshot)(pin);
      const second = await (input.readSnapshot ?? readStagingExternalSnapshot)(pin);
      if (first !== second || reconciliationDigest(first) !== pin.expectedSnapshotDigest)
        throw new Error("external_reviewed_snapshot_changed");
      const snapshot = decodeReconciliation(
        Schema.Struct({
          version: Schema.Literal("staging-external-snapshot-v1"),
          units: Schema.Array(
            Schema.Struct({
              unit: Schema.String,
              active: Schema.String,
              sub: Schema.String,
              enabled: Schema.String,
              processPresent: Schema.Boolean,
              residualProcesses: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
              unitDigest: ReconciliationDigest,
              environmentDigests: Schema.Array(ReconciliationDigest),
              processDigest: Schema.NullOr(ReconciliationDigest),
            }),
          ).check(Schema.isMaxLength(512)),
          code: Schema.Array(
            Schema.Struct({
              pathDigest: ReconciliationDigest,
              contentDigest: ReconciliationDigest,
            }),
          ),
        }),
        JSON.parse(first),
      );
      for (const name of pin.heldUnits) {
        const units = snapshot.units.filter((unit) => unit.unit === name);
        const unit = units[0];
        if (
          units.length !== 1 ||
          unit?.active !== "inactive" ||
          unit.sub !== "dead" ||
          unit.processPresent ||
          unit.residualProcesses !== 0 ||
          !["masked", "masked-runtime"].includes(unit.enabled)
        )
          throw new Error("external_held_service_unproven");
      }
      return { host: pin.host, snapshotDigest: pin.expectedSnapshotDigest };
    }),
  );
  return {
    observations,
    verifiedAt: new Date().toISOString(),
    executionAuthorized: false as const,
  };
}
