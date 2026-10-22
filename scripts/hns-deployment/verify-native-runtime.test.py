"""Refuse false native health: stale/unsynced tips, redirects and replaced processes."""
import importlib.util
import hashlib
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native", Path(__file__).with_name("verify-native-runtime.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeAcceptance(unittest.TestCase):
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
