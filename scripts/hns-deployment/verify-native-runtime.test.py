"""Refuse false native health: stale/unsynced tips, redirects and replaced processes."""
import importlib.util
import hashlib
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("verify-native-runtime.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeAcceptance(unittest.TestCase):
    def test_private_probe_requires_actual_swap_barrier(self):
        with patch.object(native, "Path") as path:
            path.return_value.read_text.return_value = "0::/example\n"
            path.return_value.__truediv__.return_value.__truediv__.return_value.read_text.return_value = "max\n"
            with self.assertRaises(native.Refused):
                native.require_zero_swap()

    def test_loaded_private_credential_drift_refuses_success(self):
        with patch.object(native, "sha256", side_effect=["old-loaded", "changed-file"]), self.assertRaises(native.Refused):
            native.loaded_credential(123, "example.service", "client", "/private/client")

    def test_reader_policy_failure_cannot_report_health(self):
        chain = {"bestblockhash": "accepted"}
        with patch.object(native, "require_zero_swap"), patch.object(native, "sha256", return_value="accepted"), \
                patch.object(native, "active_process", return_value=123), patch.object(native, "loaded_credential"), \
                patch.object(native, "validate_tip"), patch.object(native, "reader_rpc", side_effect=[chain, {}, {}]), \
                self.assertRaisesRegex(native.Refused, "extra-method-admitted"):
            native.verify_reader_and_secondary(Path("/release"), "runtime")

    def test_provisioner_schema_guard_is_select_only_and_failure_refuses_health(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "bin").mkdir()
            bundle = root / "bin/provisioner.mjs"
            bundle.write_bytes(b"bundle")
            identity = {"source_commit": "historical", "bundle_sha256": "accepted"}
            (root / "deployment-manifest.json").write_text(json.dumps(identity))
            fake_path = lambda value: root if value == "/srv/pirate-hns-authority-provisioner/current" else type("Environment", (), {"read_bytes": lambda self: b"CONTROL_PLANE_POSTGRES_URL=private-url\0"})()
            binding = {**identity, "bundle_name": "provisioner.mjs"}
            with patch.object(native, "Path", side_effect=fake_path), patch.object(native, "require_zero_swap"), \
                    patch.object(native, "sha256", return_value="accepted"), patch.object(native, "active_process", return_value=123), \
                    patch.object(native, "loaded_credential"), patch.object(native.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 0, '{"outcome":"compatible"}', "")
                self.assertEqual(native.verify_provisioner(root, binding, "runtime"), {"pirate-hns-authority-provisioner.service": 123})
                command = run.call_args.args[0]
                self.assertIn("--verify-schema", command)
                self.assertNotIn("--serve", command)
                self.assertNotIn("private-url", command)
                self.assertEqual(run.call_args.kwargs["env"]["CONTROL_PLANE_POSTGRES_URL"], "private-url")
                run.return_value = subprocess.CompletedProcess([], 2, "", "private diagnostic withheld")
                with self.assertRaises(native.Refused):
                    native.verify_provisioner(root, binding, "runtime")

    def test_actual_tip_time_not_median_time(self):
        chain = {"chain": "main", "blocks": 352395, "headers": 352395, "bestblockhash": "abc", "verificationprogress": 1}
        block = {"hash": "abc", "height": 352395, "time": 9900, "mediantime": 1}
        native.validate_tip(chain, block, 10000)
        for changes in [{"time": 1}, {"time": 11000}, {"height": 352394}, {"hash": "other"}]:
            with self.subTest(changes=changes), self.assertRaises(native.Refused):
                native.validate_tip(chain, {**block, **changes}, 10000)
        with self.assertRaises(native.Refused):
            native.validate_tip({**chain, "verificationprogress": 0}, block, 10000)

    def test_redirects_never_count_as_origin_readiness(self):
        self.assertIsNone(native.NoRedirect().redirect_request(None, None, 302, "moved", {}, "http://elsewhere/readyz"))

    def test_missing_or_caddy_only_manifest_cannot_claim_native_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(native.Refused):
                native.verify_installed_coverage("community-gateway", root)
            (root / "config").mkdir()
            manifest = root / "config/INSTALLED_SHA256SUMS"
            manifest.write_text("0" * 64 + "  /etc/caddy/caddy.json\n")
            with self.assertRaises(native.Refused):
                native.verify_installed_coverage("community-gateway", root)
            manifest.write_text("".join("0" * 64 + "  " + path + "\n"
                                        for path in sorted(native.required_installed_paths("community-gateway"))))
            native.verify_installed_coverage("community-gateway", root)

    def test_inactive_unit_or_replaced_executable_refused(self):
        with patch.object(native, "run", return_value="inactive\n"), self.assertRaises(native.Refused):
            native.active_process("example.service", "accepted")
        with patch.object(native, "run", side_effect=["active\n", "123\n"]), patch.object(native, "sha256", return_value="changed"), self.assertRaises(native.Refused):
            native.active_process("example.service", "accepted")

    def test_static_gateway_requires_bound_artifact_and_real_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            root = release / "installed"
            (root / "bin").mkdir(parents=True)
            (release / "static-native").mkdir()
            bundle = root / "bin/gateway.mjs"
            bundle.write_bytes(b"accepted bundle")
            digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
            binding = {"schema": "pirate-hns-native-bundle/1", "profile": "static-gateway",
                       "source_commit": "accepted-source", "bundle_sha256": digest,
                       "bundle_name": "gateway.mjs", "bun": {"runtime": {"binary_sha256": "runtime"}}}
            (release / "static-native/bundle-binding.json").write_text(json.dumps(binding))
            deployment = root / "DEPLOYMENT"
            accepted = "api-next_commit=accepted-source\nbundle_sha256=" + digest + "\nprofile=production\n"
            deployment.write_text(accepted)
            with patch.object(native, "Path", return_value=root), \
                    patch.object(native, "active_process", return_value=123), \
                    patch.object(native, "exchange", return_value=(204, {}, b"")) as exchange:
                self.assertEqual(native.verify_static_gateway(release, "runtime"),
                                 ("pirate-hns-platform-gateway.service", 123))
                exchange.assert_called_once_with("http://127.0.0.1:4051/readyz")
                for metadata in [accepted.replace("accepted-source", "other-source"),
                                 accepted + "api-next_commit=accepted-source\n"]:
                    deployment.write_text(metadata)
                    with self.assertRaises(native.Refused):
                        native.verify_static_gateway(release, "runtime")
                deployment.write_text(accepted)
                bundle.write_bytes(b"replaced bundle")
                with self.assertRaises(native.Refused):
                    native.verify_static_gateway(release, "runtime")
                bundle.write_bytes(b"accepted bundle")
                for response in [(503, {}, b""), (302, {}, b""), (204, {}, b"unexpected")]:
                    exchange.return_value = response
                    with self.assertRaises(native.Refused):
                        native.verify_static_gateway(release, "runtime")
                with self.assertRaises(native.Refused):
                    native.verify_static_gateway(release, "other-runtime")


if __name__ == "__main__":
    unittest.main()
