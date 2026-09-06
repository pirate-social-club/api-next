"""Real signed RRsets through wire decoding, plus acquisition failure recovery."""

import copy
import importlib.util
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

import dns.dnssec
import dns.flags
import dns.message
import dns.rdatatype
import dns.rrset
from cryptography.hazmat.primitives.asymmetric import ec

spec = importlib.util.spec_from_file_location("freshness", pathlib.Path(__file__).with_name("zone-freshness.py"))
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)

NOW = 1800000000
ROOT = "fixture."
PIN = "ab" * 32


def fixture(serial=10, expiration=NOW + 3600, pin=PIN, private=None):
    private = private or ec.generate_private_key(ec.SECP256R1())
    key = dns.dnssec.make_dnskey(private.public_key(), 13, flags=257)
    keyset = dns.rrset.from_rdata(ROOT, 300, key)
    ds = dns.dnssec.make_ds(ROOT, key, "SHA256")
    rrsets = {
        "DNSKEY": keyset,
        "SOA": dns.rrset.from_text(ROOT, 300, "IN", "SOA", f"ns1.fixture. hostmaster.fixture. {serial} 300 60 86400 60"),
        "TLSA": dns.rrset.from_text("_443._tcp.app.fixture.", 300, "IN", "TLSA", "3 1 1 " + pin),
    }
    messages = {}
    for kind, rrset in rrsets.items():
        signature = dns.dnssec.sign(rrset, private, ROOT, key, inception=NOW - 3600,
                                   expiration=expiration)
        request = dns.message.make_query(rrset.name, kind, want_dnssec=True)
        response = dns.message.make_response(request)
        response.flags |= dns.flags.AA
        response.answer.extend([rrset, dns.rrset.from_rdata(rrset.name, 300, signature)])
        messages[kind] = dns.message.from_wire(response.to_wire())
    return ds, messages


class SignatureTests(unittest.TestCase):
    def test_real_signed_answers_and_rfc1982_rollover(self):
        ds, messages = fixture()
        self.assertEqual(monitor.verify_view(ROOT, [ds], messages, PIN, NOW)["serial"], 10)
        self.assertIsNone(monitor.serial_condition(10, 10))
        self.assertEqual(monitor.serial_condition(1, 4294967295), "secondary_zone_lag")
        self.assertEqual(monitor.serial_condition(4294967295, 1), "primary_zone_lag")
        self.assertEqual(monitor.serial_condition(2147483648, 0), "zone_serial_order_undefined")

    def test_expired_missing_and_corrupted_signatures(self):
        ds, expired = fixture(expiration=NOW - 1)
        with self.assertRaisesRegex(monitor.Refusal, "dns_signature_invalid"):
            monitor.verify_view(ROOT, [ds], expired, PIN, NOW)
        ds, messages = fixture()
        messages["SOA"].answer.pop()
        with self.assertRaisesRegex(monitor.Refusal, "dns_signature_missing"):
            monitor.verify_view(ROOT, [ds], messages, PIN, NOW)
        ds, messages = fixture()
        messages["SOA"].answer[0] = dns.rrset.from_text(ROOT, 300, "IN", "SOA",
            "ns1.fixture. hostmaster.fixture. 99 300 60 86400 60")
        with self.assertRaisesRegex(monitor.Refusal, "dns_signature_invalid"):
            monitor.verify_view(ROOT, [ds], messages, PIN, NOW)

    def test_changed_chain_ds_and_signed_wrong_pin(self):
        ds, messages = fixture()
        other_ds, _ = fixture()
        with self.assertRaisesRegex(monitor.Refusal, "chain_ds_mismatch"):
            monitor.verify_view(ROOT, [other_ds], messages, PIN, NOW)
        ds, messages = fixture(pin="cd" * 32)
        with self.assertRaisesRegex(monitor.Refusal, "dns_tlsa_pin_mismatch"):
            monitor.verify_view(ROOT, [ds], messages, PIN, NOW)

    def test_wrong_owner_and_wildcard_signature_are_refused(self):
        ds, messages = fixture()
        messages["SOA"].answer[0].name = dns.name.from_text("other.")
        with self.assertRaisesRegex(monitor.Refusal, "dns_answer_invalid"):
            monitor.verify_view(ROOT, [ds], messages, PIN, NOW)
        ds, messages = fixture()
        signature = messages["SOA"].answer[1]
        changed = signature[0].replace(labels=0)
        messages["SOA"].answer[1] = dns.rrset.from_rdata(ROOT, 300, changed)
        with self.assertRaisesRegex(monitor.Refusal, "dns_signature_invalid"):
            monitor.verify_view(ROOT, [ds], messages, PIN, NOW)


class ObservationTests(unittest.TestCase):
    def test_direct_authority_failure_does_not_hide_other_authority(self):
        ds, messages = fixture()
        config = {"root": ROOT, "pin": PIN, "authorities": [
            {"role": "primary", "address": "192.0.2.1"},
            {"role": "secondary", "address": "192.0.2.2"}]}

        class Source:
            broken = True
            moved = False
            calls = 0

            def tip(self):
                self.calls += 1
                return "new" if self.moved and self.calls % 2 == 0 else "old"

            def rpc(self, method, params):
                assert method == "getnameresource" and params == [ROOT, False]
                return {"records": [{"type": "DS", "keyTag": ds.key_tag,
                    "algorithm": ds.algorithm, "digestType": ds.digest_type, "digest": ds.digest.hex()}]}

            def query(self, address, owner, kind):
                if self.broken and address == "192.0.2.1":
                    raise TimeoutError()
                return copy.deepcopy(messages[kind])

        source = Source()
        original_time = monitor.time.time
        monitor.time.time = lambda: NOW
        try:
            self.assertEqual(monitor.observe(config, source)["conditions"],
                             ["primary_dns_observation_unavailable"])
            source.broken = False
            self.assertEqual(monitor.observe(config, source)["conditions"], [])
            source.moved = True
            with self.assertRaisesRegex(monitor.Refusal, "chain_tip_changed"):
                monitor.observe(config, source)
        finally:
            monitor.time.time = original_time

    def test_signed_secondary_lag_and_same_serial_disagreement(self):
        private = ec.generate_private_key(ec.SECP256R1())
        ds, primary = fixture(serial=1, private=private)
        _, secondary = fixture(serial=4294967295, private=private)
        config = {"root": ROOT, "pin": PIN, "authorities": [
            {"role": "primary", "address": "192.0.2.1"},
            {"role": "secondary", "address": "192.0.2.2"}]}

        class Source:
            def tip(self):
                return "stable"

            def rpc(self, method, params):
                return {"records": [{"type": "DS", "keyTag": ds.key_tag,
                    "algorithm": ds.algorithm, "digestType": ds.digest_type, "digest": ds.digest.hex()}]}

            def query(self, address, owner, kind):
                return (primary if address.endswith("1") else secondary)[kind]

        from unittest.mock import patch
        with patch.object(monitor.time, "time", return_value=NOW):
            self.assertEqual(monitor.observe(config, Source())["conditions"], ["secondary_zone_lag"])
            _, secondary = fixture(serial=1, private=private)
            self.assertEqual(monitor.observe(config, Source())["conditions"], [])
            rr = secondary["SOA"].answer[0]
            replacement = dns.rrset.from_text(ROOT, 300, "IN", "SOA",
                "ns1.fixture. hostmaster.fixture. 1 400 60 86400 60")
            key = primary["DNSKEY"].answer[0][0]
            sig = dns.dnssec.sign(replacement, private, ROOT, key,
                                 inception=NOW - 100, expiration=NOW + 100)
            secondary["SOA"].answer = [replacement, dns.rrset.from_rdata(rr.name, 300, sig)]
            self.assertEqual(monitor.observe(config, Source())["conditions"], ["zone_serving_records_disagree"])

    def test_stale_or_wrong_chain_is_not_healthy(self):
        from unittest.mock import patch
        config = {"driver_port": 1234, "driver_reference": "fixture:driver"}
        source = monitor.Acquisition(config)
        tip = {"chain": "main", "verificationprogress": 1, "blocks": 123, "bestblockhash": "ab" * 32}
        header = {"hash": "ab" * 32, "height": 123, "time": NOW - 21601}
        with patch.object(source, "rpc", side_effect=[tip, header]), patch.object(monitor.time, "time", return_value=NOW):
            with self.assertRaisesRegex(monitor.Refusal, "chain_tip_stale"):
                source.tip()
        with patch.object(source, "rpc", return_value={**tip, "chain": "regtest"}):
            with self.assertRaisesRegex(monitor.Refusal, "chain_observation_invalid"):
                source.tip()


if __name__ == "__main__":
    unittest.main()
