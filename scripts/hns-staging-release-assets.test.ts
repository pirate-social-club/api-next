import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const role = "apps/hns-authority-provisioner/ops/staging-mainnet";
const bundleHash = "34029a3cf81dda85a7f9fc6eed3d9655be08a930fb17db3f1497b7618fe72a24";
const manifestHash = "34f51467e42481bf829e774943a63860bf8946f755fb5b73a5727f455c19204c";
const runtimeHash = "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74";
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "staging-assets-test-"));
  temporary.push(directory);
  const bin = join(directory, "mock-bin");
  const output = join(directory, "release");
  mkdirSync(bin);
  mkdirSync(output);
  mkdirSync(join(directory, role, "bin"), { recursive: true });
  mkdirSync(join(directory, "scripts/hns-deployment"), { recursive: true });
  for (const path of [
    `${role}/bin/stage-release-assets.sh`,
    `${role}/deployment-manifest.gateway-v4.json`,
    `${role}/deployment-manifest.gateway.json`,
    "scripts/hns-deployment/git-provenance.sh",
  ]) {
    copyFileSync(join(root, path), join(directory, path));
  }
  copyFileSync(
    join(directory, role, "deployment-manifest.gateway.json"),
    join(output, "deployment-manifest.gateway.json"),
  );
  const bundle = join(directory, "gateway.mjs");
  const runtime = join(directory, "bun");
  const provisioner = join(directory, "provisioner.mjs");
  writeFileSync(bundle, "fixture-v4");
  writeFileSync(runtime, "fixture-runtime");
  writeFileSync(provisioner, "fixture-provisioner");
  // Model only the command boundaries. These fixtures cannot be release inputs:
  // real packaging uses Git ancestry and real SHA-256 without these test shims.
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/python3
import os,sys
with open(os.environ['CALLS'],'a') as f:f.write('git '+ ' '.join(sys.argv[1:])+'\\n')
a=sys.argv[1:]
if a==['rev-parse','--show-toplevel']:print(os.environ['FIXTURE_ROOT'])
elif 'show-ref' in a:pass
elif 'merge-base' in a:sys.exit(1 if os.environ.get('UNACCEPTED')=='true' else 0)
else:sys.exit(90)
`,
  );
  writeFileSync(
    join(bin, "sha256sum"),
    `#!/usr/bin/python3
import hashlib,os,pathlib,sys
mapping={'fixture-v4':'${bundleHash}','fixture-runtime':'${runtimeHash}','fixture-v3':'f19d0a9280a181b4efa892788646e7619e0ec6705a3f2c2421bbe59b320b5902','fixture-provisioner':'66339d830ff63676b9243985af593c9a40d382ea10790a64fd96241b965b095e'}
assert sys.argv[1:]==['-c','-']
for line in sys.stdin:
 expected,path=line.rstrip('\\n').split('  ',1)
 with open(os.environ['CALLS'],'a') as f:f.write('sha256 '+expected+' '+path+'\\n')
 raw=pathlib.Path(path).read_bytes()
 actual=mapping.get(raw.decode(errors='replace'),hashlib.sha256(raw).hexdigest())
 if actual!=expected:sys.exit(1)
`,
  );
  for (const name of ["git", "sha256sum"]) chmodSync(join(bin, name), 0o755);
  const calls = join(directory, "calls");
  function run(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string> = {
      PATH: `${bin}:/usr/bin:/bin`,
      FIXTURE_ROOT: directory,
      CALLS: calls,
      HNS_STAGING_ASSET_PROFILE: "posting-v4",
      HNS_STAGING_GATEWAY_BUNDLE: bundle,
      HNS_STAGING_GATEWAY_RUNTIME: runtime,
    };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const result = Bun.spawnSync(
      ["bash", join(directory, role, "bin/stage-release-assets.sh"), output],
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    );
    return { exit: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
  }
  return { directory, output, bundle, runtime, provisioner, calls, run };
}

function noAssets(output: string) {
  expect(existsSync(join(output, "gateway"))).toBe(false);
  expect(existsSync(join(output, "provisioner"))).toBe(false);
  expect(readdirSync(output)).toEqual(["deployment-manifest.gateway.json"]);
}

test("the fixed manifest binds exact native bytes, V4 listeners and unchanged transport identity", () => {
  const raw = readFileSync(join(root, role, "deployment-manifest.gateway-v4.json"));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(manifestHash);
  const value = JSON.parse(raw.toString());
  expect(Buffer.from(JSON.stringify(value))).toEqual(raw);
  expect(value.bundle_sha256).toBe(bundleHash);
  expect(value.api_next_source_commit).toBe("97a701a7afa1274ebb73e1e9705fba1a95e61803");
  expect(value.profile_version).toBe("pirate-hns-community-app-interactive-gateway-v4");
  expect(value.staging_gateway_listener).toBe("127.0.0.1:4269");
  expect(value.staging_health_listener).toBe("127.0.0.1:4271");
  expect(value.solid_ingress_composition_reference).toBe(
    "solid-hns-ingress-sha256:ca8947f90135419945ed697af91e429bc07b45e04d8ace973f655fe6f37758f5",
  );
});

test("gateway-only staging checks all inputs before copying, preserves bytes and never touches provisioner", () => {
  const f = fixture();
  const result = f.run({ HNS_STAGING_PROVISIONER_BUNDLE: "/does-not-exist/never-read" });
  expect(result.exit, result.stderr).toBe(0);
  expect(
    readFileSync(join(f.output, "gateway/bin/pirate-hns-community-app-handle-gateway.mjs")),
  ).toEqual(readFileSync(f.bundle));
  expect(readFileSync(join(f.output, "gateway/bin/bun"))).toEqual(readFileSync(f.runtime));
  expect(readFileSync(join(f.output, "gateway/deployment-manifest.json"))).toEqual(
    readFileSync(join(f.directory, role, "deployment-manifest.gateway-v4.json")),
  );
  expect(readdirSync(f.output).sort()).toEqual(["deployment-manifest.gateway.json", "gateway"]);
  expect(lstatSync(join(f.output, "gateway/bin/bun")).mode & 0o777).toBe(0o555);
  const calls = readFileSync(f.calls, "utf8").split("\n").filter(Boolean);
  expect(calls.filter((line) => line.startsWith("sha256 "))).toHaveLength(6);
  expect(
    calls.some((line) =>
      line.includes(
        "merge-base --is-ancestor 97a701a7afa1274ebb73e1e9705fba1a95e61803 refs/remotes/origin/main",
      ),
    ),
  ).toBe(true);
  expect(calls.some((line) => line.includes(f.provisioner) || line.includes("76cd679e"))).toBe(
    false,
  );
});

for (const input of ["bundle", "runtime", "manifest"] as const) {
  test(`wrong ${input} refuses before asset output`, () => {
    const f = fixture();
    const path =
      input === "manifest"
        ? join(f.directory, role, "deployment-manifest.gateway-v4.json")
        : f[input];
    writeFileSync(path, "wrong bytes");
    expect(f.run().exit).not.toBe(0);
    noAssets(f.output);
  });
}

test("unaccepted source refuses before any asset output", () => {
  const f = fixture();
  expect(f.run({ UNACCEPTED: "true" }).exit).not.toBe(0);
  noAssets(f.output);
});

test("unsupported profile refuses without staging either application", () => {
  const f = fixture();
  expect(f.run({ HNS_STAGING_ASSET_PROFILE: "arbitrary-new-profile" }).exit).not.toBe(0);
  noAssets(f.output);
});

test("empty explicit profile and missing or indirect runtime refuse before asset output", () => {
  const f = fixture();
  expect(f.run({ HNS_STAGING_ASSET_PROFILE: "" }).exit).not.toBe(0);
  expect(f.run({ HNS_STAGING_GATEWAY_RUNTIME: undefined }).exit).not.toBe(0);
  expect(f.run({ HNS_STAGING_GATEWAY_RUNTIME: "relative-bun" }).exit).not.toBe(0);
  const link = join(f.directory, "runtime-link");
  symlinkSync(f.runtime, link);
  expect(f.run({ HNS_STAGING_GATEWAY_RUNTIME: link }).exit).not.toBe(0);
  noAssets(f.output);
});

for (const name of ["gateway", "provisioner"]) {
  test(`existing ${name} directory or dangling selector refuses without changes`, () => {
    const f = fixture();
    const path = join(f.output, name);
    mkdirSync(path);
    expect(f.run().exit).not.toBe(0);
    expect(readdirSync(path)).toEqual([]);
    rmSync(path, { recursive: true });
    symlinkSync("missing-protected-target", path);
    expect(f.run().exit).not.toBe(0);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });
}

test("historical staging body stays byte-identical, including its disclosed stale-template refusal", () => {
  const source = readFileSync(join(root, role, "bin/stage-release-assets.sh"), "utf8");
  const historical = source.slice(source.indexOf("app_source=76cd679e"));
  expect(createHash("sha256").update(historical).digest("hex")).toBe(
    "f4444338d57fc55c56b69a4ab6cebc9c247dbbe87ebe208d422823a9c635c64e",
  );
});

for (const profile of [undefined, "historical-v3"]) {
  test(`historical ${profile ?? "default"} preserves original assets and stale-template refusal`, () => {
    const f = fixture();
    writeFileSync(f.bundle, "fixture-v3");
    const result = f.run({
      HNS_STAGING_ASSET_PROFILE: profile,
      HNS_STAGING_GATEWAY_RUNTIME: undefined,
      HNS_STAGING_PROVISIONER_BUNDLE: f.provisioner,
    });
    // Existing source expects canonical b145, while its tracked template is34f.
    // Preserve that refusal rather than changing unrelated historical behavior.
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain("AssertionError");
    expect(
      readFileSync(join(f.output, "provisioner/bin/pirate-hns-authority-provisioner.mjs")),
    ).toEqual(readFileSync(f.provisioner));
    expect(existsSync(join(f.output, "provisioner/deployment-manifest.json"))).toBe(false);
    const calls = readFileSync(f.calls, "utf8");
    expect(calls).toContain(
      "merge-base --is-ancestor 76cd679ead1a680bb74a47f6718d3e0e7e4e5f3f refs/remotes/origin/main",
    );
    expect(calls).not.toContain(runtimeHash);
  });
}
