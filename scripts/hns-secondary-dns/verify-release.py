#!/usr/bin/env python3
"""Read-only verification of a reviewed secondary DNS release; no alert delivery."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

IMAGE_DIGEST = "sha256:f976e753a1de8ec62636203ecb12ae5fa3d1055601be167de53f1f673e0abe59"
IMAGE = "powerdns/pdns-auth-51@" + IMAGE_DIGEST
CONTAINER = "pirate-hns-secondary-dns"
CURRENT = Path("/srv/pirate-hns-secondary/current")
DATA = Path("/srv/pirate-hns-secondary/shared/data")
FILES = ("compose.yaml", "config/pdns.conf", "config/secondary-trigger.sql",
         "verify-release.py", "pirate-hns-secondary-verify.service",
         "pirate-hns-secondary-verify.timer", "README.md")


class Refusal(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def regular_bytes(path):
    require(path.is_file() and not path.is_symlink(), "artifact_not_regular")
    require(path.stat().st_size <= 262144, "artifact_too_large")
    return path.read_bytes()


def manifest_for(release, source_commit):
    require(re.fullmatch(r"[0-9a-f]{40}", source_commit), "invalid_source_commit")
    return {"version": "hns-secondary-release-v1", "source_commit": source_commit,
            "image": IMAGE,
            "files": {name: digest(regular_bytes(release / name)) for name in FILES}}


def verify_artifacts(release, expected_digest):
    require(re.fullmatch(r"[0-9a-f]{64}", expected_digest), "invalid_manifest_digest")
    raw = regular_bytes(release / "manifest.json")
    require(digest(raw) == expected_digest, "manifest_digest_mismatch")
    manifest = json.loads(raw)
    require(set(manifest) == {"version", "source_commit", "image", "files"},
            "manifest_shape_mismatch")
    require(manifest == manifest_for(release, manifest["source_commit"]),
            "artifact_or_manifest_mismatch")
    return manifest


def run(command):
    result = subprocess.run(command, capture_output=True, timeout=12, check=False)
    require(result.returncode == 0, "runtime_command_failed")
    require(len(result.stdout) <= 1048576, "runtime_output_too_large")
    return result.stdout


def verify_container(state, mounted_config_digest, expected_config_digest):
    require(state["Image"] == IMAGE_DIGEST and state["Config"]["Image"] == IMAGE,
            "runtime_image_mismatch")
    require(state["State"]["Running"] and not state["State"]["Restarting"],
            "runtime_not_running")
    require(state["HostConfig"]["NetworkMode"] == "host" and
            state["HostConfig"]["RestartPolicy"]["Name"] == "unless-stopped" and
            state["HostConfig"]["Privileged"] is False, "runtime_profile_mismatch")
    require(state["Config"]["Cmd"] == [
        "--local-address=81.15.150.159,127.0.0.1", "--allow-notify-from=94.103.168.161"
    ], "runtime_command_mismatch")
    require(state["Config"]["Entrypoint"] == [
        "/bin/sh", "-lc", "umask 0002 && exec /usr/local/sbin/pdns_server-startup $@", "--"
    ], "runtime_entrypoint_mismatch")
    mounts = {item["Destination"]: (item["Source"], item["RW"], item["Type"])
              for item in state["Mounts"]}
    require(len(state["Mounts"]) == 2 and mounts == {
        "/etc/powerdns/pdns.conf": (str(CURRENT / "config/pdns.conf"), False, "bind"),
        "/var/lib/powerdns": (str(DATA), True, "bind")
    }, "runtime_mount_mismatch")
    require(mounted_config_digest == expected_config_digest, "mounted_config_mismatch")


def compact_sql(sql):
    return " ".join(sql.strip().rstrip(";").split())


def verify_database(database, trigger_sql):
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True,
                                 timeout=5)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        triggers = connection.execute(
            "SELECT name,sql FROM sqlite_master WHERE type='trigger'"
        ).fetchall()
        require(len(triggers) == 1 and
                triggers[0][0] == "pirate_secondary_readiness_tsig_axfr_v1" and
                compact_sql(triggers[0][1]) == compact_sql(trigger_sql),
                "database_trigger_mismatch")
        require(connection.execute(
            "SELECT ip,nameserver,account FROM supermasters"
        ).fetchall() == [("94.103.168.161", "ns2.pirate", "pirate-primary")],
                "database_autoprimary_mismatch")
        keys = connection.execute("SELECT name,algorithm,length(secret) FROM tsigkeys").fetchall()
        require(len(keys) == 1 and keys[0][0] == "pirate-axfr" and
                keys[0][1] == "hmac-sha256" and keys[0][2] == 88,
                "database_tsig_key_shape_mismatch")
        zones = connection.execute("SELECT id,type,master,account FROM domains").fetchall()
        require(len(zones) > 0 and all((kind, primary, account) == ("SLAVE", "94.103.168.161", "pirate-primary")
                for _, kind, primary, account in zones),
                "database_zone_role_mismatch")
        expected = {"AXFR-MASTER-TSIG": "pirate-axfr", "TSIG-ALLOW-AXFR": "pirate-axfr",
                    "PRESIGNED": "1"}
        metadata = connection.execute("SELECT domain_id,kind,content FROM domainmetadata").fetchall()
        # Exact metadata also refuses per-zone unsigned AXFR or Lua policy overrides.
        require(len(metadata) == len(zones) * len(expected) and
                set(metadata) == {(zone_id, key, value) for zone_id, *_ in zones
                                  for key, value in expected.items()},
                "database_metadata_mismatch")
        return len(zones)
    finally:
        connection.rollback()
        connection.close()


def verify_runtime(release, manifest):
    state = json.loads(run(["/usr/bin/docker", "inspect", CONTAINER]))
    require(isinstance(state, list) and len(state) == 1, "runtime_inspect_shape")
    image = json.loads(run(["/usr/bin/docker", "image", "inspect", IMAGE]))
    require(len(image) == 1 and state[0]["Config"]["Env"] == image[0]["Config"]["Env"],
            "runtime_environment_override")
    mounted = run(["/usr/bin/docker", "exec", CONTAINER, "sha256sum",
                   "/etc/powerdns/pdns.conf"]).decode().split()[0]
    verify_container(state[0], mounted, manifest["files"]["config/pdns.conf"])
    return verify_database(DATA / "pdns.sqlite3",
                           regular_bytes(release / "config/secondary-trigger.sql").decode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--emit-manifest", metavar="SOURCE_COMMIT",
                        help="print proposed manifest only; does not write or approve a release")
    parser.add_argument("--manifest-sha256-file", type=Path)
    parser.add_argument("--files-only", action="store_true",
                        help="verify staged bytes only, without asserting runtime health")
    args = parser.parse_args()
    try:
        if args.emit_manifest:
            require(not args.manifest_sha256_file and not args.files_only,
                    "conflicting_arguments")
            print(json.dumps(manifest_for(args.release, args.emit_manifest),
                             sort_keys=True, separators=(",", ":")))
            return 0
        require(args.manifest_sha256_file is not None, "missing_manifest_trust_anchor")
        expected = regular_bytes(args.manifest_sha256_file).decode().strip()
        manifest = verify_artifacts(args.release, expected)
        zone_count = None if args.files_only else verify_runtime(args.release, manifest)
        print(json.dumps({"event": "hns_secondary_release_verified",
                          "observed_at": datetime.now(timezone.utc).isoformat(),
                          "source_commit": manifest["source_commit"],
                          "manifest_sha256": expected, "zone_count": zone_count,
                          "mode": "files-only" if args.files_only else "runtime",
                          "delivery": "local-only"}, sort_keys=True))
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError, IndexError,
            sqlite3.Error, subprocess.TimeoutExpired) as error:
        # No raw process output, DNS names, environment, database or secret bytes.
        code = str(error) if isinstance(error, Refusal) else "verification_unavailable"
        print(json.dumps({"event": "hns_secondary_release_refused", "code": code,
                          "delivery": "local-only"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
