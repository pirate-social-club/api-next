#!/usr/bin/env python3
"""Bounded A-response continuity check; no DNSSEC validation is performed."""
import argparse
import base64
import ipaddress
import re
import struct
import sys

MAX_WIRE = 65535
MAX_METADATA = 256
MESSAGE_ID = 0x2A2A


def probe_settings(name, expected_ipv4):
    labels = name.removesuffix(".").split(".")
    if not all(re.fullmatch(r"[A-Za-z0-9_-]{1,63}", label) for label in labels):
        raise ValueError("HNS_DOH_PROBE_NAME must be a nonempty ASCII DNS name")
    encoded = tuple(label.lower().encode("ascii") for label in labels)
    if sum(len(label) + 1 for label in encoded) + 1 > 255:
        raise ValueError("HNS_DOH_PROBE_NAME exceeds the DNS name limit")
    try:
        address = ipaddress.IPv4Address(expected_ipv4)
    except ipaddress.AddressValueError as exc:
        raise ValueError("HNS_DOH_EXPECTED_IPV4 must be an explicit IPv4 address") from exc
    return encoded, address.packed


def make_query(labels):
    name = b"".join(bytes([len(label)]) + label for label in labels) + b"\0"
    wire = struct.pack("!6H", MESSAGE_ID, 0x0100, 1, 0, 0, 0) + name + struct.pack("!HH", 1, 1)
    return base64.urlsafe_b64encode(wire).rstrip(b"=").decode("ascii")


class Message:
    def __init__(self, wire):
        if not 12 <= len(wire) <= MAX_WIRE:
            raise ValueError("invalid DNS message length")
        self.wire = wire
        self.boundaries = set()

    def name(self, offset):
        labels = []
        cursor, end, expanded, hops = offset, None, 1, 0
        while True:
            if cursor >= len(self.wire):
                raise ValueError("truncated DNS name")
            size = self.wire[cursor]
            if size & 0xC0 == 0xC0:
                if cursor + 1 >= len(self.wire):
                    raise ValueError("truncated compression pointer")
                target = ((size & 0x3F) << 8) | self.wire[cursor + 1]
                if target >= cursor or target not in self.boundaries or hops >= 128:
                    raise ValueError("invalid compression pointer")
                self.boundaries.add(cursor)
                end = cursor + 2 if end is None else end
                cursor, hops = target, hops + 1
                continue
            if size & 0xC0 or cursor + size + 1 > len(self.wire):
                raise ValueError("invalid DNS label")
            self.boundaries.add(cursor)
            cursor += 1
            if size == 0:
                return tuple(labels), cursor if end is None else end
            expanded += size + 1
            if expanded > 255:
                raise ValueError("expanded DNS name exceeds limit")
            labels.append(self.wire[cursor:cursor + size].lower())
            cursor += size

    def record(self, offset, section):
        owner, offset = self.name(offset)
        if offset + 10 > len(self.wire):
            raise ValueError("truncated resource record")
        kind, rrclass, ttl, length = struct.unpack_from("!HHIH", self.wire, offset)
        start, end = offset + 10, offset + 10 + length
        if end > len(self.wire):
            raise ValueError("truncated resource data")
        value = self.wire[start:end]
        if kind in (1, 28) and length != (4 if kind == 1 else 16):
            raise ValueError("invalid address record length")
        # Register suffix boundaries in the common name-bearing RDATA forms.
        # Other RDATA is opaque but bounded; pointers into opaque bytes refuse.
        if kind in (2, 5, 12, 15, 33, 6):
            prefix = 2 if kind == 15 else 6 if kind == 33 else 0
            if start + prefix >= end:
                raise ValueError("truncated name resource data")
            target, consumed = self.name(start + prefix)
            if kind == 6:
                _, consumed = self.name(consumed)
                consumed += 20
            if consumed != end:
                raise ValueError("invalid name resource data length")
            if kind == 5:
                value = target
        if kind == 41:
            if section != "additional" or owner or ttl >> 16:
                raise ValueError("invalid OPT or extended DNS error")
            cursor = start
            while cursor < end:
                if cursor + 4 > end:
                    raise ValueError("truncated EDNS option")
                option_length = struct.unpack_from("!H", self.wire, cursor + 2)[0]
                cursor += 4 + option_length
                if cursor > end:
                    raise ValueError("truncated EDNS option data")
        return (owner, kind, rrclass, value), end


def validate_response(wire, labels, expected):
    message = Message(wire)
    identifier, flags, questions, answers, authorities, additional = struct.unpack_from("!6H", wire)
    if identifier != MESSAGE_ID or not flags & 0x8000 or flags & (0x7800 | 0x0200 | 0x0040 | 0x000F):
        raise ValueError("wrong request identity, DNS flags or response code")
    if questions != 1 or answers < 1 or answers + authorities + additional > 4096:
        raise ValueError("invalid DNS section counts")
    question, offset = message.name(12)
    if offset + 4 > len(wire) or question != labels or wire[offset:offset + 4] != b"\0\1\0\1":
        raise ValueError("question does not match the A-IN request")
    offset += 4
    answer_rows, opt_count = [], 0
    for section, count in [("answer", answers), ("authority", authorities), ("additional", additional)]:
        for _ in range(count):
            row, offset = message.record(offset, section)
            opt_count += row[1] == 41
            if section == "answer":
                answer_rows.append(row)
    if offset != len(wire) or opt_count > 1:
        raise ValueError("trailing DNS bytes or duplicate OPT record")
    addresses, aliases = {}, {}
    for owner, kind, rrclass, value in answer_rows:
        if rrclass == 1 and kind in (1, 5):
            (addresses if kind == 1 else aliases).setdefault(owner, set()).add(value)
    current, seen = labels, set()
    while current in aliases:
        if current in seen or len(seen) >= 32 or current in addresses or len(aliases[current]) != 1:
            raise ValueError("invalid CNAME chain")
        seen.add(current)
        current = next(iter(aliases[current]))
        if not current:
            raise ValueError("CNAME target is the root")
    if addresses.get(current) != {expected}:
        raise ValueError("no exact expected A data for the requested owner or CNAME chain")
    return str(ipaddress.IPv4Address(expected))


def validate_curl_stream(stream, labels, expected):
    payload = stream.read(MAX_WIRE + MAX_METADATA + 1)
    if len(payload) > MAX_WIRE + MAX_METADATA:
        raise ValueError("DoH response exceeds the bounded input size")
    parts = payload.rsplit(b"\n", 3)
    if len(parts) != 4 or parts[3] or parts[1] != b"200" or len(parts[2]) > 128:
        raise ValueError("missing curl metadata or HTTP status is not200")
    if parts[2].split(b";", 1)[0].strip().lower() != b"application/dns-message":
        raise ValueError("HTTP content type is not application/dns-message")
    return validate_response(parts[0], labels, expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("query", "check"))
    parser.add_argument("--name", required=True)
    parser.add_argument("--expected-ipv4", required=True)
    args = parser.parse_args()
    try:
        labels, expected = probe_settings(args.name, args.expected_ipv4)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    try:
        print(make_query(labels) if args.mode == "query" else validate_curl_stream(sys.stdin.buffer, labels, expected))
        return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
