#!/usr/bin/env python3
"""Exercise real release files and read-only SQLite policy verification."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
SOURCE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("secondary_verifier", SOURCE / "verify-release.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class SecondaryReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.release = self.root / "release"
        self.release.mkdir()
        for name in verifier.FILES:
            target = self.release / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, target)
        self.manifest = verifier.manifest_for(self.release, "a" * 40)
        self.manifest_raw = json.dumps(self.manifest).encode()
        (self.release / "manifest.json").write_bytes(self.manifest_raw)
        self.anchor = self.root / "manifest.sha256"
        self.anchor.write_text(verifier.digest(self.manifest_raw) + "\n")
        self.database = self.root / "pdns.sqlite3"
        self.trigger = (SOURCE / "config/secondary-trigger.sql").read_text()
        with sqlite3.connect(self.database) as c:
            c.executescript("""
                CREATE TABLE domains (id INTEGER PRIMARY KEY,type TEXT,master TEXT,account TEXT);
                CREATE TABLE domainmetadata (domain_id INTEGER,kind TEXT,content TEXT);
                CREATE TABLE supermasters (ip TEXT,nameserver TEXT,account TEXT);
                CREATE TABLE tsigkeys (name TEXT,algorithm TEXT,secret TEXT);
            """ + self.trigger)
            c.execute("INSERT INTO domains VALUES(1,'SLAVE','94.103.168.161','pirate-primary')")
            c.execute("INSERT INTO domainmetadata VALUES(1,'AXFR-MASTER-TSIG','pirate-axfr')")
            c.execute("INSERT INTO domainmetadata VALUES(1,'PRESIGNED','1')")
            c.execute("INSERT INTO supermasters VALUES('94.103.168.161','ns2.pirate','pirate-primary')")
            c.execute("INSERT INTO tsigkeys VALUES('pirate-axfr','hmac-sha256',?)", ("x" * 88,))
        self.state = {
            "Image": verifier.IMAGE_DIGEST,
            "Config": {"Image": verifier.IMAGE, "Cmd": [
                "--local-address=81.15.150.159,127.0.0.1", "--allow-notify-from=94.103.168.161"
            ], "Entrypoint": ["/bin/sh", "-lc",
                "umask 0002 && exec /usr/local/sbin/pdns_server-startup $@", "--"]},
            "State": {"Running": True, "Restarting": False},
            "HostConfig": {"NetworkMode": "host", "RestartPolicy": {"Name": "unless-stopped"},
                           "Privileged": False},
            "Mounts": [
                {"Source": str(verifier.CURRENT / "config/pdns.conf"),
                 "Destination": "/etc/powerdns/pdns.conf", "RW": False, "Type": "bind"},
                {"Source": str(verifier.DATA), "Destination": "/var/lib/powerdns",
                 "RW": True, "Type": "bind"}
            ]
        }

    def test_cli_staged_verification_and_corruption_refusal(self):
        command = [sys.executable, str(SOURCE / "verify-release.py"), "--release",
                   str(self.release), "--manifest-sha256-file", str(self.anchor), "--files-only"]
        result = subprocess.run(command, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["mode"], "files-only")
        self.assertIsNone(receipt["zone_count"])
        self.assertEqual(receipt["delivery"], "local-only")
        (self.release / "config/pdns.conf").write_text("secret-value-not-for-logs")
        result = subprocess.run(command, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)["code"], "artifact_or_manifest_mismatch")
        self.assertNotIn(b"secret-value", result.stdout + result.stderr)

    def test_manifest_anchor_and_symlink_refusals(self):
        with self.assertRaisesRegex(verifier.Refusal, "manifest_digest_mismatch"):
            verifier.verify_artifacts(self.release, "0" * 64)
        target = self.release / "config/pdns.conf"
        target.unlink()
        target.symlink_to(SOURCE / "config/pdns.conf")
        with self.assertRaisesRegex(verifier.Refusal, "artifact_not_regular"):
            verifier.verify_artifacts(self.release, verifier.digest(self.manifest_raw))

    def test_live_policy_is_read_only_and_trigger_provisions_successor_zone(self):
        before = self.database.read_bytes()
        self.assertEqual(verifier.verify_database(self.database, self.trigger), 1)
        self.assertEqual(self.database.read_bytes(), before)
        with sqlite3.connect(self.database) as c:
            c.execute("INSERT INTO domains VALUES(2,'SLAVE','94.103.168.161','pirate-primary')")
            c.execute("INSERT INTO domainmetadata VALUES(2,'AXFR-MASTER-TSIG','pirate-axfr')")
            c.execute("INSERT INTO domainmetadata VALUES(2,'PRESIGNED','1')")
        self.assertEqual(verifier.verify_database(self.database, self.trigger), 2)

    def test_database_policy_drift(self):
        mutations = [
            ("DROP TRIGGER pirate_secondary_readiness_tsig_axfr_v1", "trigger"),
            ("DELETE FROM domainmetadata WHERE kind='TSIG-ALLOW-AXFR'", "metadata"),
            ("INSERT INTO domainmetadata VALUES(1,'ALLOW-AXFR-FROM','0.0.0.0/0')", "metadata"),
            ("UPDATE domains SET type='MASTER'", "zone_role"),
            ("UPDATE domains SET master='192.0.2.1'", "zone_role"),
            ("UPDATE supermasters SET ip='192.0.2.1'", "autoprimary"),
            ("UPDATE tsigkeys SET secret='unreviewed'", "tsig_key_shape")
        ]
        baseline = self.database.read_bytes()
        for sql, code in mutations:
            with self.subTest(code=code, sql=sql):
                self.database.write_bytes(baseline)
                with sqlite3.connect(self.database) as c:
                    c.execute(sql)
                with self.assertRaisesRegex(verifier.Refusal, "database_" + code + "_mismatch"):
                    verifier.verify_database(self.database, self.trigger)

    def test_runtime_drift_refusal(self):
        verifier.verify_container(self.state, "a" * 64, "a" * 64)
        mutations = [
            lambda s: s.update(Image="sha256:" + "b" * 64),
            lambda s: s["State"].update(Running=False),
            lambda s: s["HostConfig"].update(NetworkMode="bridge"),
            lambda s: s["Config"].update(Cmd=["--api=yes"]),
            lambda s: s["Config"].update(Entrypoint=["/bin/other"]),
            lambda s: s["Mounts"][0].update(RW=True),
            lambda s: s["Mounts"][1].update(Source="/tmp/ephemeral-dns")
        ]
        for mutate in mutations:
            state = copy.deepcopy(self.state)
            mutate(state)
            with self.subTest(state=state), self.assertRaises(verifier.Refusal):
                verifier.verify_container(state, "a" * 64, "a" * 64)
        with self.assertRaisesRegex(verifier.Refusal, "mounted_config_mismatch"):
            verifier.verify_container(self.state, "b" * 64, "a" * 64)


if __name__ == "__main__":
    unittest.main()
