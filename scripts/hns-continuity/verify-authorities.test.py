import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import dns.message
import dns.rdatatype


class AuthorityReplayTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hns-authority-replay-")
        self.directory = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.source = Path(__file__).parent
        retained = json.loads(gzip.decompress((self.source / "fixtures/continuity-observation.json.gz").read_bytes()))
        self.proof = retained["authority-verification"]
        self.proof["certificate_der_hex"] = (self.source / "fixtures/gateway-certificate.der").read_bytes().hex()
        inventory = json.loads(bytes.fromhex(retained["state"]["inventory"]["bytes_hex"]))
        endpoints = [entry for entry in inventory["authoritative_nameserver_glue"] if entry["active"]]
        transport = {"authorities": [{"address": entry["authority_address"], "nameserver": entry["authority_nameserver"], "dns_port": 1} for entry in endpoints], "gateway_port": 1}
        for name in ["state", "chain"]:
            (self.directory / (name + ".json")).write_text(json.dumps(retained[name]))
        (self.directory / "transport.json").write_text(json.dumps(transport))

    def replay(self):
        (self.directory / "authority-verification.json").write_text(json.dumps(self.proof))
        return subprocess.run([sys.executable, str(self.source / "verify-authorities.py"), str(self.directory), "--replay"], capture_output=True, timeout=15)

    def test_validates_archived_dnssec_and_retained_public_certificate(self):
        result = self.replay()
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_refuses_changed_signature(self):
        exchange = self.proof["views"][0]["exchanges"][0]
        response = dns.message.from_wire(bytes.fromhex(exchange["response_hex"]))
        for record in response.answer:
            if record.rdtype == dns.rdatatype.RRSIG:
                original = record[0]
                record.clear()
                record.add(original.replace(signature=b"\0" * len(original.signature)))
        exchange["response_hex"] = response.to_wire().hex()
        result = self.replay()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"ValidationFailure", result.stderr)

    def test_refuses_changed_certificate_and_missing_certificate(self):
        self.proof["certificate_der_hex"] = "00"
        self.assertNotEqual(self.replay().returncode, 0)
        del self.proof["certificate_der_hex"]
        self.assertNotEqual(self.replay().returncode, 0)

    def test_refuses_changed_tlsa_expectation(self):
        state_path = self.directory / "state.json"
        state = json.loads(state_path.read_text())
        state["dns"]["gateway_certificate_spki_sha256"] = "0" * 64
        state_path.write_text(json.dumps(state))
        result = self.replay()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"TLSA mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
