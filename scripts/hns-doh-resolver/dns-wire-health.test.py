#!/usr/bin/env python3
"""Offline wire and actual shell transport regressions for the public probe."""
import base64
import importlib.util
import io
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("dns_wire_health", HERE / "bin/dns-wire-health.py")
HEALTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HEALTH)
LABELS, EXPECTED = HEALTH.probe_settings("app.pirate", "192.0.2.17")


def name(value):
    return b"".join(bytes([len(label)]) + label.encode("ascii") for label in value.split(".")) + b"\0"


def record(owner=b"\xc0\x0c", kind=1, data=EXPECTED, rrclass=1):
    return owner + struct.pack("!HHIH", kind, rrclass, 60, len(data)) + data


def packet(rows=None, question=None, identifier=0x2A2A, flags=0x8180, authority=(), additional=()):
    rows = [record()] if rows is None else rows
    question = name("app.pirate") + b"\0\1\0\1" if question is None else question
    return (struct.pack("!6H", identifier, flags, 1, len(rows), len(authority), len(additional))
            + question + b"".join(rows) + b"".join(authority) + b"".join(additional))


def curl_output(wire, status=b"200", content_type=b"application/dns-message"):
    return wire + b"\n" + status + b"\n" + content_type + b"\n"


class WireTests(unittest.TestCase):
    def valid(self, wire):
        self.assertEqual(HEALTH.validate_response(wire, LABELS, EXPECTED), "192.0.2.17")

    def invalid(self, wire):
        with self.assertRaises(ValueError):
            HEALTH.validate_response(wire, LABELS, EXPECTED)

    def test_query_is_exact_a_in_and_normalizes_case(self):
        labels, address = HEALTH.probe_settings("APP.Pirate.", "192.0.2.17")
        self.assertEqual((labels, address), (LABELS, EXPECTED))
        encoded = HEALTH.make_query(labels)
        wire = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        self.assertEqual(wire, struct.pack("!6H", 0x2A2A, 0x0100, 1, 0, 0, 0) + name("app.pirate") + b"\0\1\0\1")

    def test_bad_configuration_refuses(self):
        for probe in ["", ".", "app..pirate", "app.pirate..", "a" * 64 + ".pirate", "a b.pirate", "é.pirate", ".".join(["a" * 63] * 4)]:
            with self.subTest(name=probe), self.assertRaises(ValueError):
                HEALTH.probe_settings(probe, "192.0.2.17")
        for address in ["", "::1", "example.invalid", "192.0.2.999", "192.0.2.017"]:
            with self.subTest(address=address), self.assertRaises(ValueError):
                HEALTH.probe_settings("app.pirate", address)

    def test_direct_compressed_and_uncompressed_answers(self):
        self.valid(packet())
        self.valid(packet([record(owner=name("APP.PIRATE"))]))
        self.valid(packet([record(), record()]))

    def test_cname_chain_requires_matching_terminal_data(self):
        first = record(kind=5, data=name("gateway.pirate"))
        second = record(owner=name("gateway.pirate"), kind=5, data=name("edge.pirate"))
        last = record(owner=name("edge.pirate"))
        self.valid(packet([first, second, last]))
        for rows in [[first], [first, record(owner=name("other.pirate"))],
                     [first, record(owner=name("gateway.pirate"), data=b"\xc0\x00\x02\x63")],
                     [first, record()], [first, record(kind=5, data=name("other.pirate"))],
                     [first, record(owner=name("gateway.pirate"), kind=5, data=b"\xc0\x0c")]]:
            with self.subTest(rows=rows):
                self.invalid(packet(rows))

    def test_compression_to_validated_prior_pointer(self):
        first = record(kind=5, data=b"\x07gateway\xc0\x10")
        # The first RDATA starts at question-end + compressed-owner/header.
        question_end = 12 + len(name("app.pirate")) + 4
        target = question_end + 12
        pointer = struct.pack("!H", 0xC000 | target)
        second_owner = question_end + len(first)
        pointer_to_pointer = struct.pack("!H", 0xC000 | second_owner)
        self.valid(packet([first, record(owner=pointer), record(owner=pointer_to_pointer)]))

    def test_full_authority_and_additional_sections_are_consumed(self):
        authority = [record(owner=name("pirate"), kind=2, data=name("ns.pirate"))]
        opt = record(owner=b"\0", kind=41, rrclass=1232, data=b"\0\x0f\0\x02\0\0")
        self.valid(packet(authority=authority, additional=[record(owner=name("ns.pirate")), opt]))
        self.invalid(packet(additional=[opt, opt]))
        self.invalid(packet(additional=[record(owner=b"\0", kind=41, data=b"\0\x0f\0\x02\0")]))
        self.invalid(packet(additional=[b"\0" + struct.pack("!HHIH", 41, 1232, 0x01000000, 0)]))

    def test_every_truncation_and_trailing_bytes_refuse(self):
        wire = packet()
        for length in range(len(wire)):
            with self.subTest(length=length):
                self.invalid(wire[:length])
        self.invalid(wire + b"\0")
        self.invalid(bytes.fromhex("2a2a81800001000100000000"))

    def test_wrong_id_flags_question_or_section_counts_refuse(self):
        self.invalid(packet(identifier=0x2A2B))
        for flags in [0x0180, 0x8980, 0x8380, 0x81C0, 0x8182, 0x8183]:
            with self.subTest(flags=flags):
                self.invalid(packet(flags=flags))
        for question in [name("other.pirate") + b"\0\1\0\1", name("app.pirate") + b"\0\x1c\0\1", name("app.pirate") + b"\0\1\0\3"]:
            self.invalid(packet(question=question))
        self.invalid(packet(rows=[]))
        self.invalid(packet()[:4] + b"\0\2" + packet()[6:])
        self.invalid(packet()[:6] + b"\xff\xff" + packet()[8:])

    def test_wrong_address_type_class_or_owner_refuse(self):
        for rows in [[record(data=b"\xc0\x00\x02\x12")], [record(kind=28, data=b"\0" * 16)],
                     [record(rrclass=3)], [record(owner=name("other.pirate"))],
                     [record(), record(data=b"\xc0\x00\x02\x12")], [record(data=b"\xc0\0\x02")]]:
            with self.subTest(rows=rows):
                self.invalid(packet(rows))

    def test_invalid_name_encoding_compression_and_rdata_refuse(self):
        for owner in [b"\xc0\xff", b"\xc0\0", b"\xc0\x0d", b"\x40", b"\xff", b"\xc0\x1c"]:
            with self.subTest(owner=owner):
                self.invalid(packet([record(owner=owner)]))
        for data in [b"", name("gateway.pirate") + b"\0", b"\x07gateway\xc0\xff"]:
            self.invalid(packet([record(kind=5, data=data)]))
        # Backward pointer to the current name prefix would expand forever.
        self.invalid(packet([record(owner=b"\x01a" + struct.pack("!H", 0xC000 | 28))]))

    def test_http_metadata_and_size_are_required(self):
        self.assertEqual(HEALTH.validate_curl_stream(io.BytesIO(curl_output(packet())), LABELS, EXPECTED), "192.0.2.17")
        for value in [packet(), curl_output(packet(), status=b"201"), curl_output(packet(), status=b"302"),
                      curl_output(packet(), content_type=b"text/html"), curl_output(packet(), content_type=b"application/dns-message-evil"),
                      curl_output(packet(), content_type=b""), curl_output(b"x" * (HEALTH.MAX_WIRE + 1)),
                      b"x" * (HEALTH.MAX_WIRE + HEALTH.MAX_METADATA + 1)]:
            with self.subTest(length=len(value)), self.assertRaises(ValueError):
                HEALTH.validate_curl_stream(io.BytesIO(value), LABELS, EXPECTED)


class ShellTransportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        self.events = self.root / "events"
        self.body = self.root / "response"
        self.body.write_bytes(curl_output(packet()))
        curl = fake_bin / "curl"
        curl.write_text("#!/usr/bin/env python3\nimport os,pathlib,sys\n"
                        "with open(os.environ['DOH_TEST_EVENTS'],'a') as f: f.write('curl\\n')\n"
                        "args=sys.argv[1:]\n"
                        "assert '--disable' in args and '--max-time' in args and '--write-out' in args\n"
                        "assert args[args.index('--url')+1].startswith('https://resolver.invalid/dns-query?dns=')\n"
                        "sys.stdout.buffer.write(pathlib.Path(os.environ['DOH_TEST_RESPONSE']).read_bytes())\n"
                        "sys.exit(int(os.environ.get('DOH_TEST_CURL_EXIT','0')))\n")
        curl.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(fake_bin) + os.pathsep + os.environ['PATH'],
                                PYTHONDONTWRITEBYTECODE="1", HNS_DOH_ENDPOINT="https://resolver.invalid/dns-query",
                                HNS_DOH_PROBE_NAME="app.pirate", HNS_DOH_EXPECTED_IPV4="192.0.2.17",
                                HNS_DOH_TIMEOUT_SECONDS="1", HNS_DOH_ATTEMPTS="2", HNS_DOH_BASE_DELAY_SECONDS="0",
                                DOH_TEST_RESPONSE=str(self.body), DOH_TEST_EVENTS=str(self.events))

    def run_probe(self, **overrides):
        environment = dict(self.environment, **overrides)
        return subprocess.run(["bash", str(HERE / "bin/check-doh-health.sh")], env=environment,
                              capture_output=True, text=True, timeout=15, check=False)

    def test_only_valid_complete_response_signals_success(self):
        result = self.run_probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("192.0.2.17", result.stdout)
        self.assertEqual(self.events.read_text(), "curl\n")

    def test_malformed_response_retries_then_fails_without_success(self):
        self.body.write_bytes(curl_output(bytes.fromhex("2a2a81800001000100000000")))
        result = self.run_probe()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("DoH health failure", result.stderr)
        self.assertEqual(self.events.read_text(), "curl\ncurl\n")

    def test_valid_body_with_transport_failure_never_signals_success(self):
        result = self.run_probe(DOH_TEST_CURL_EXIT="28")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(self.events.read_text(), "curl\ncurl\n")

    def test_bad_settings_refuse_before_network(self):
        cases = [{"HNS_DOH_EXPECTED_IPV4": ""}, {"HNS_DOH_EXPECTED_IPV4": "::1"},
                 {"HNS_DOH_PROBE_NAME": "app..pirate"}, {"HNS_DOH_ENDPOINT": "http://resolver.invalid"},
                 {"HNS_DOH_ATTEMPTS": "0"}, {"HNS_DOH_TIMEOUT_SECONDS": "99"}]
        for settings in cases:
            with self.subTest(settings=settings):
                result = self.run_probe(**settings)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(self.events.exists())


if __name__ == "__main__":
    unittest.main()
