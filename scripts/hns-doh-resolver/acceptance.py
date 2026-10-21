#!/usr/bin/env python3
"""Acceptance suite for the Pirate HNS DoH resolver.

Exercises the real path: DoH client -> Caddy -> dnsdist -> hnsd, in both GET
(base64url ?dns=) and POST (application/dns-message) forms.

Usage:
    ./acceptance.py [--endpoint https://dns.pirate.sc/dns-query]

Exits non-zero if any REQUIRED check fails. Checks marked advisory report but do
not fail the run, because they depend on live third-party HNS names.
"""
import argparse
import base64
import struct
import sys
import urllib.error
import urllib.request

TYPES = {"A": 1, "NS": 2, "CNAME": 5, "TXT": 16, "AAAA": 28, "DS": 43, "DNSKEY": 48, "TLSA": 52}
RCODES = {0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}

failures = []
advisories = []


def build_query(name, qtype, msgid=0x2A2A, want_dnssec=False):
    q = b""
    for label in name.split("."):
        if label:
            q += bytes([len(label)]) + label.encode()
    q += b"\x00"
    arcount = 1 if want_dnssec else 0
    extra = b""
    if want_dnssec:
        # OPT RR with the DO bit set.
        extra = b"\x00" + struct.pack(">HHIH", 41, 4096, 0x00008000, 0)
    header = struct.pack(">HHHHHH", msgid, 0x0100, 1, 0, 0, arcount)
    return header + q + struct.pack(">HH", TYPES[qtype], 1) + extra


def _skip_name(buf, off):
    while True:
        length = buf[off]
        if length == 0:
            return off + 1
        if length & 0xC0 == 0xC0:
            return off + 2
        off += 1 + length


def parse(buf):
    msgid, flags = struct.unpack(">HH", buf[0:4])
    qd, an, ns, ar = struct.unpack(">HHHH", buf[4:12])
    off = 12
    answer_types = []
    try:
        for _ in range(qd):
            off = _skip_name(buf, off) + 4
        for _ in range(an):
            off = _skip_name(buf, off)
            rrtype, _rrclass, _ttl, rdlength = struct.unpack(">HHIH", buf[off:off + 10])
            off += 10 + rdlength
            answer_types.append(rrtype)
    except (IndexError, struct.error):
        # Truncated or unparseable answer section; report what we managed to read
        # rather than crashing the suite.
        pass
    return {
        "id": msgid,
        "rcode": flags & 0xF,
        "ancount": an,
        "nscount": ns,
        "answer_types": answer_types,
    }


def doh(endpoint, wire, method="GET", timeout=20, headers=None):
    hdrs = {"accept": "application/dns-message"}
    hdrs.update(headers or {})
    if method == "GET":
        enc = base64.urlsafe_b64encode(wire).rstrip(b"=").decode()
        req = urllib.request.Request(f"{endpoint}?dns={enc}", headers=hdrs)
    else:
        hdrs["content-type"] = "application/dns-message"
        req = urllib.request.Request(endpoint, data=wire, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.headers.get("content-type", ""), resp.read()


def check(label, required, fn):
    try:
        ok, detail = fn()
    except Exception as exc:  # noqa: BLE001 - report any failure shape
        ok, detail = False, f"{type(exc).__name__}: {exc}"
    mark = "PASS" if ok else ("FAIL" if required else "WARN")
    print(f"[{mark}] {label}: {detail}")
    if not ok:
        (failures if required else advisories).append(label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="https://dns.pirate.sc/dns-query")
    args = ap.parse_args()
    ep = args.endpoint
    print(f"endpoint: {ep}\n")

    def resolves(name, qtype, method="GET", want_dnssec=False, expect_rcode=0, msgid=0x2A2A):
        """Positive checks must return real data, not merely NOERROR.

        A NOERROR/ancount=0 response is a valid DNS answer meaning "the name
        exists but has no record of this type" -- accepting it would let every
        positive check below pass while the resolver returns nothing useful.
        """
        def run():
            status, ctype, body = doh(ep, build_query(name, qtype, msgid, want_dnssec), method)
            if status != 200:
                return False, f"HTTP {status}"
            if "application/dns-message" not in ctype:
                return False, f"wrong content-type: {ctype!r}"
            r = parse(body)
            if r["id"] != msgid:
                return False, f"request id not preserved: sent {msgid:#x} got {r['id']:#x}"
            if r["rcode"] != expect_rcode:
                return False, f"rcode {RCODES.get(r['rcode'], r['rcode'])}, expected {RCODES.get(expect_rcode)}"
            if expect_rcode != 0:
                return True, f"{RCODES.get(r['rcode'])} ({method})"
            if r["ancount"] < 1:
                return False, f"NOERROR but ancount=0 -- no {qtype} record returned ({method})"
            want = TYPES[qtype]
            # A CNAME chain terminating in the requested type is legitimate.
            if want not in r["answer_types"] and TYPES["CNAME"] not in r["answer_types"]:
                got = ", ".join(str(t) for t in r["answer_types"]) or "none"
                return False, f"no {qtype} (or CNAME) in answer; types present: {got} ({method})"
            return True, f"{RCODES.get(r['rcode'])} answers={r['ancount']} type={qtype} ({method})"
        return run

    # Our own names must resolve. These are REQUIRED: they prove the whole path.
    check("GET  app.pirate A", True, resolves("app.pirate", "A"))
    check("POST app.pirate A", True, resolves("app.pirate", "A", method="POST"))
    check("GET  app.pirate TLSA (DO bit)", True,
          resolves("_443._tcp.app.pirate", "TLSA", want_dnssec=True))
    check("GET  pirate DNSKEY", True, resolves("pirate", "DNSKEY", want_dnssec=True))
    check("GET  wildcard *.pirate", True, resolves("acceptance-probe.pirate", "A"))

    # Real recursion beyond our own zone. Advisory: depends on a third party.
    check("GET  g A (external HNS TLD)", False, resolves("g", "A"))

    # dankmeme is no longer zoneless: it serves a signed zone anchored by a
    # parent DS. The label "delegated, no zone" described the state at the time
    # this check was written and is now false -- and because the check only
    # asserted "did not hang", it kept passing while silently testing something
    # else. Assert the property that actually holds now.
    #
    # This means the original fail-closed case (a delegation with no zone behind
    # it) is no longer covered here and wants a genuinely zoneless name.
    def signed_external_delegation():
        status, _, body = doh(ep, build_query("dankmeme", "NS"), "GET")
        if status != 200:
            return False, f"HTTP {status}"
        r = parse(body)
        if r["rcode"] != 0:
            return False, f"expected NOERROR, got {RCODES.get(r['rcode'], r['rcode'])}"
        if r["ancount"] < 1:
            return False, "NOERROR but no NS answers"
        return True, f"NOERROR answers={r['ancount']}"
    check("GET  dankmeme NS (delegated, signed zone)", True, signed_external_delegation)

    # NXDOMAIN against an external zone without our *.pirate wildcard. A name
    # below .pirate is expected to match the wildcard and cannot test NXDOMAIN.
    check("GET  NXDOMAIN outside wildcard zone", False,
          resolves("no-such-name.g", "A", expect_rcode=3))

    # AXFR/IXFR/ANY must produce a fail-closed response with no usable answer.
    # The DoH frontend currently returns NOTIMP for transfer types, while the
    # dnsdist rule returns REFUSED for ANY. Do not claim which layer rejected a
    # request solely from its rcode; this check proves the externally visible
    # rejection property, not internal rule execution.
    def rejected(qtype_num):
        def run():
            wire = build_query("pirate", "A")
            wire = wire[:-4] + struct.pack(">HH", qtype_num, 1)
            _, _, body = doh(ep, wire, "GET")
            r = parse(body)
            return r["rcode"] in (4, 5), RCODES.get(r["rcode"], r["rcode"])
        return run
    check("GET  AXFR rejected", True, rejected(252))
    check("GET  IXFR rejected", True, rejected(251))
    check("GET  ANY rejected", True, rejected(255))

    # Malformed payloads must be rejected, not proxied blindly.
    def malformed():
        try:
            status, _, _ = doh(ep, b"\x00\x01\x02", "POST")
            return status >= 400, f"HTTP {status}"
        except urllib.error.HTTPError as exc:
            return exc.code >= 400, f"HTTP {exc.code}"
    check("POST malformed payload rejected", True, malformed)

    # NOTE: rate-limit identity under a spoofed X-Forwarded-For is deliberately
    # NOT tested here. A single request that returns 200 proves nothing about
    # which address dnsdist attributed it to, and proving it properly means
    # either reading dnsdist metrics or driving the limit past its threshold --
    # neither of which belongs in a suite that runs against production.
    #
    # Verify it instead as a controlled deployment observation: stand up dnsdist
    # with a temporary low-QPS test policy, then confirm that rotating
    # attacker-supplied left-side XFF values cannot evade a limit attached to the
    # real right-most peer address. Do not fire 25+ production queries to
    # approximate this. See the XFF/grey-cloud section of README.md.

    print()
    if failures:
        print(f"FAILED ({len(failures)}): {', '.join(failures)}")
    if advisories:
        print(f"advisory warnings ({len(advisories)}): {', '.join(advisories)}")
    if not failures:
        print("all required checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
