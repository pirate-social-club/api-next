#!/usr/bin/env python3
"""Rebuild accepted production bundles; never installs or rotates them."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

PROFILES = {
    "observer-driver": {
        "source_commit": "7d3c8aae24240faf7dde3e35fb359f96caa934b7",
        "bundle_sha256": "956977e5af68ce4afc0cf4746dbd7ce9c973d0c65123dc7db10b98348293e411",
        "bundle_name": "pirate-hns-observer-driver.mjs",
    },
    "community-gateway": {
        "source_commit": "97a701a7afa1274ebb73e1e9705fba1a95e61803",
        "bundle_sha256": "34029a3cf81dda85a7f9fc6eed3d9655be08a930fb17db3f1497b7618fe72a24",
        "bundle_name": "pirate-hns-community-app-gateway.mjs",
    },
    "static-gateway": {
        "source_commit": "e7b0b247613691c27aedfd80da63d8a79615f10d",
        "bundle_sha256": "619c035de3b8588cd9a429d03df1e997febaf27ebfe5e55ac325e33b00548120",
        "bundle_name": "pirate-hns-platform-gateway.mjs",
    },
    "authority-provisioner": {
        "source_commit": "9fed1f47a8a97cac763249963f40f97163e3e1a5",
        "reconstruction_base": "1cdaa010a494e8af37426142f6ed2dad93ff1225",
        "source_patch": "production-provisioner-renewal.patch",
        "source_patch_sha256": "4e6e88c124cdc2afd592e8b0a3d6b1ff170418e5f001396acbd604a6c5bb6e39",
        "patched_files": {
            "apps/hns-authority-provisioner/src/observe-root.ts": "4ba56a97aac16418e208ddb6bdfc656e613dcc0e7d4d48e9810a0f4d53d99b39",
            "apps/hns-authority-provisioner/src/observe-root.test.ts": "532c27241ce1ab370b2d7aef7af081a1e8869071df328675451c0a14c1d087b8",
        },
        "compiler": "runtime",
        "bundle_sha256": "35759a39dd22f406f36b8b05d987d0b581a0a403b63191feb1a0ec23a402b5ec",
        "bundle_name": "pirate-hns-authority-provisioner.mjs",
    },
}
BUN = {
    "compiler": {
        "version": "1.4.0",
        "archive_sha256": "2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452",
        "binary_sha256": "33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b",
    },
    "runtime": {
        "version": "1.3.14",
        "archive_sha256": "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
        "binary_sha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74",
    },
}
CLOUDFLARED = {
    "version": "2026.8.3",
    "binary_sha256": "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(256 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, path, expected):
    with urllib.request.urlopen(url, timeout=60) as response, open(path, "xb") as output:
        shutil.copyfileobj(response, output)
    if sha256(path) != expected:
        raise RuntimeError("download checksum mismatch")


def bun_binary(kind, work):
    pin = BUN[kind]
    archive = work / (kind + ".zip")
    url = f"https://github.com/oven-sh/bun/releases/download/bun-v{pin['version']}/bun-linux-x64.zip"
    download(url, archive, pin["archive_sha256"])
    path = work / ("bun-" + kind)
    with zipfile.ZipFile(archive) as zipped:
        path.write_bytes(zipped.read("bun-linux-x64/bun"))
    if sha256(path) != pin["binary_sha256"]:
        raise RuntimeError("Bun binary checksum mismatch")
    path.chmod(0o755)
    return path


def reconstruct_source(root, source, pin):
    if "source_patch" not in pin:
        return
    patch = root / "scripts/hns-deployment" / pin["source_patch"]
    if sha256(patch) != pin["source_patch_sha256"]:
        raise RuntimeError("historical source patch checksum mismatch")
    subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-i", str(patch)], cwd=source, check=True)
    for name, expected in pin["patched_files"].items():
        if sha256(source / name) != expected:
            raise RuntimeError("reconstructed source checksum mismatch")


def build(profile, output):
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root):
        raise RuntimeError("refusing a dirty build checkout")
    if output.exists() or output.is_symlink():
        raise RuntimeError("output already exists")
    pin = PROFILES[profile]
    with tempfile.TemporaryDirectory(prefix="hns-native-bundle-") as temporary:
        work = Path(temporary)
        runtime = bun_binary("runtime", work)
        compiler_kind = pin.get("compiler", "compiler")
        compiler = runtime if compiler_kind == "runtime" else bun_binary("compiler", work)
        archive_commit = pin.get("reconstruction_base", pin["source_commit"])
        subprocess.run([str(root / "scripts/hns-deployment/make-app-release.sh"), str(work),
                        "--commit", archive_commit], cwd=root, check=True)
        source = work / "app-releases" / archive_commit
        env = dict(os.environ, PATH=str(work) + ":" + os.environ.get("PATH", ""))
        (work / "bun").symlink_to(compiler)
        subprocess.run([str(compiler), "install", "--frozen-lockfile", "--ignore-scripts"],
                       cwd=source, env=env, check=True)
        subprocess.run(["sha256sum", "--check", "--status", ".pirate-deployment/SHA256SUMS"],
                       cwd=source, check=True)
        reconstruct_source(root, source, pin)
        if profile != "community-gateway":
            app = {"observer-driver": "hns-observer-driver", "static-gateway": "hns-platform-gateway",
                   "authority-provisioner": "hns-authority-provisioner"}[profile]
            subprocess.run([str(compiler), "run", "--cwd", "apps/" + app, "build:vps-bundle"],
                           cwd=source, env=env, check=True)
            bundle = source / "apps" / app / "dist" / pin["bundle_name"]
        else:
            # Exact historical build options. The sealed archive supplies the
            # commit normally read from its clean Git checkout by that builder.
            build_script = work / "build-gateway.mjs"
            build_script.write_text("const r=await Bun.build(" + json.dumps({
                "entrypoints": ["src/combined-main.ts"], "outdir": str(work / "gateway"),
                "naming": pin["bundle_name"], "target": "bun", "format": "esm",
                "minify": False, "sourcemap": "none",
                "define": {"__PIRATE_API_NEXT_SOURCE_COMMIT__": json.dumps(pin["source_commit"])},
            }) + ");if(!r.success)throw Error('archived gateway build refused');\n")
            subprocess.run([str(compiler), str(build_script)],
                           cwd=source / "apps/hns-platform-gateway", env=env, check=True)
            bundle = work / "gateway" / pin["bundle_name"]
        if sha256(bundle) != pin["bundle_sha256"]:
            raise RuntimeError("rebuild differs from the accepted deployed bundle")
        staged = work / "output"
        (staged / "bin").mkdir(parents=True)
        shutil.copy2(bundle, staged / "bin" / pin["bundle_name"])
        shutil.copy2(runtime, staged / "bin/bun")
        binding = {"schema": "pirate-hns-native-bundle/1", "profile": profile,
                   **pin, "bun": {"compiler": BUN[compiler_kind], "runtime": BUN["runtime"]}}
        if profile == "observer-driver":
            url = "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64"
            download(url, staged / "bin/cloudflared", CLOUDFLARED["binary_sha256"])
            (staged / "bin/cloudflared").chmod(0o755)
            binding["cloudflared"] = CLOUDFLARED
        (staged / "bundle-binding.json").write_text(json.dumps(binding, indent=2) + "\n")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staged, output)
    print(json.dumps({"profile": profile, "source_commit": pin["source_commit"],
                      "bundle_sha256": pin["bundle_sha256"], "output": str(output)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", choices=PROFILES)
    parser.add_argument("output", type=Path)
    parser.add_argument("--execute", action="store_true", help="download and rebuild; otherwise print the pinned plan")
    args = parser.parse_args()
    if args.execute:
        build(args.profile, args.output.absolute())
    else:
        pin = PROFILES[args.profile]
        print(json.dumps({"profile": args.profile, **pin,
                          "bun": {"compiler": BUN[pin.get("compiler", "compiler")], "runtime": BUN["runtime"]},
                          "cloudflared": CLOUDFLARED if args.profile == "observer-driver" else None,
                          "execute": False}))


if __name__ == "__main__":
    main()
