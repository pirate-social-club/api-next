"""Historical reconstruction must reproduce the accepted source or refuse."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("builder", Path(__file__).with_name("build-native-app-bundle.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ReconstructionAcceptance(unittest.TestCase):
    def test_provisioner_reconstruction_and_tamper_refusal(self):
        root = Path(__file__).resolve().parents[2]
        pin = builder.PROFILES["authority-provisioner"]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            for name in pin["patched_files"]:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(subprocess.check_output(["git", "show", pin["reconstruction_base"] + ":" + name], cwd=root))
            builder.reconstruct_source(root, source, pin)
            for name, expected in pin["patched_files"].items():
                self.assertEqual(builder.sha256(source / name), expected)
            with self.assertRaisesRegex(RuntimeError, "patch checksum mismatch"):
                builder.reconstruct_source(root, source, {**pin, "source_patch_sha256": "0" * 64})
        self.assertEqual(builder.BUN[pin["compiler"]]["version"], "1.3.14")


if __name__ == "__main__":
    unittest.main()
