"""Bounded, read-only DNSSEC observation for the existing operator monitor."""

import base64
import http.client
import ipaddress
import json
import math
import re
import sys
import time

import dns.dnssec
import dns.flags
import dns.message
import dns.name
import dns.query
import dns.rdatatype
import dns.rrset


class Refusal(Exception):
    pass


def refuse(code):
    raise Refusal(code)


def serial_condition(primary, secondary):
    difference = (primary - secondary) % (2 ** 32)
    if difference == 0:
        return None
    if difference == 2 ** 31:
        return "zone_serial_order_undefined"
    return "secondary_zone_lag" if difference < 2 ** 31 else "primary_zone_lag"


def answer(response, owner, kind):
    matches = [rr for rr in response.answer
               if rr.name == owner and rr.rdtype == kind and rr.rdclass == 1]
    if len(matches) != 1 or not matches[0]:
        refuse("dns_answer_invalid")
    return matches[0]


def signed_answer(response, owner, kind, keys, apex, now):
    rrset = answer(response, owner, kind)
    signatures = [rr for rr in response.answer if rr.name == owner
                  and rr.rdtype == dns.rdatatype.RRSIG and rr.covers == kind]
    if len(signatures) != 1:
        refuse("dns_signature_missing")
    # Exact owners, no wildcard reconstruction or off-zone signing authority.
    signature = signatures[0]
    if any(sig.signer != apex or sig.labels != len(owner.labels) - 1 for sig in signature):
        refuse("dns_signature_invalid")
    try:
        dns.dnssec.validate(rrset, signature, {apex: keys}, now=now)
    except Exception:
        refuse("dns_signature_invalid")
    return rrset


def verify_view(root, ds, messages, pin, now):
    apex = dns.name.from_text(root)
    keys = answer(messages["DNSKEY"], apex, dns.rdatatype.DNSKEY)
    trusted = dns.rrset.RRset(apex, 1, dns.rdatatype.DNSKEY)
    for key in keys:
        for record in ds:
            if record.digest_type not in (2, 4):
                continue
            try:
                derived = dns.dnssec.make_ds(apex, key, record.digest_type)
            except Exception:
                continue
            if derived == record:
                trusted.add(key, keys.ttl)
    if not trusted:
        refuse("chain_ds_mismatch")
    signed_answer(messages["DNSKEY"], apex, dns.rdatatype.DNSKEY, trusted, apex, now)
    soa = signed_answer(messages["SOA"], apex, dns.rdatatype.SOA, keys, apex, now)
    if len(soa) != 1:
        refuse("dns_answer_invalid")
    tlsa_owner = dns.name.from_text("_443._tcp.app." + root)
    tlsa = signed_answer(messages["TLSA"], tlsa_owner, dns.rdatatype.TLSA, keys, apex, now)
    if not any(record.usage == 3 and record.selector == 1 and record.mtype == 1
               and record.cert.hex() == pin for record in tlsa):
        refuse("dns_tlsa_pin_mismatch")
    return {"serial": soa[0].serial,
            "soa": sorted(record.to_text() for record in soa),
            "tlsa": sorted(record.to_text() for record in tlsa)}


class Acquisition:
    def __init__(self, config):
        self.config = config
        self.deadline = time.monotonic() + 30

    def timeout(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            refuse("observation_timeout")
        return min(3, remaining)

    def rpc(self, method, params):
        wire = json.dumps({"method": method, "params": params}, separators=(",", ":")).encode()
        body = json.dumps({
            "version": "pirate-hns-private-driver-request-v1", "exchange_kind": "hsd_json_rpc",
            "driver_reference": self.config["driver_reference"],
            "request_bytes_base64": base64.b64encode(wire).decode(),
            "response_max_bytes": 65536, "timeout_ms": max(1, int(self.timeout() * 1000)),
        }, separators=(",", ":"))
        connection = http.client.HTTPConnection("127.0.0.1", self.config["driver_port"],
                                                timeout=self.timeout())
        try:
            connection.request("POST", "/internal/hns-observer-driver/v1/hsd", body, {
                "Content-Type": "application/json", "Accept": "application/octet-stream",
                "Pirate-HNS-Driver-Protocol": "pirate-hns-private-driver-v1",
            })
            response = connection.getresponse()
            if (response.status != 200
                    or response.getheader("Pirate-HNS-Driver-Upstream-Status") != "200"
                    or response.getheader("Pirate-HNS-Driver-Protocol") != "pirate-hns-private-driver-v1"
                    or response.getheader("Content-Type") != "application/octet-stream"):
                refuse("chain_observation_unavailable")
            raw = response.read(65537)
            if len(raw) > 65536:
                refuse("chain_observation_invalid")
            decoded = json.loads(raw)
            if decoded.get("error") is not None or not isinstance(decoded.get("result"), dict):
                refuse("chain_observation_invalid")
            return decoded["result"]
        finally:
            connection.close()

    def tip(self):
        value = self.rpc("getblockchaininfo", [])
        progress = value.get("verificationprogress")
        if (value.get("chain") != "main" or type(progress) not in (int, float)
                or not math.isfinite(progress) or not 0.9999 <= progress <= 1
                or type(value.get("blocks")) is not int or value["blocks"] < 1
                or not re.fullmatch("[0-9a-f]{64}", str(value.get("bestblockhash")))):
            refuse("chain_observation_invalid")
        header = self.rpc("getblockheader", [value["bestblockhash"], True])
        observed = header.get("time")
        if (header.get("hash") != value["bestblockhash"] or header.get("height") != value["blocks"]
                or type(observed) not in (int, float) or not math.isfinite(observed)
                or not -7200 <= time.time() - observed <= 21600):
            refuse("chain_tip_stale")
        return value["bestblockhash"]

    def query(self, address, owner, kind):
        request = dns.message.make_query(owner, kind, want_dnssec=True)
        request.flags &= ~dns.flags.RD
        response = dns.query.tcp(request, address, timeout=self.timeout())
        if (not request.is_response(response) or response.rcode() != 0
                or not response.flags & dns.flags.AA or response.flags & dns.flags.TC):
            refuse("dns_answer_invalid")
        return response


def observe(config, source=None):
    source = source or Acquisition(config)
    root = config["root"]
    conditions = []
    before = source.tip()
    resource = source.rpc("getnameresource", [root, False])
    records = resource.get("records")
    if not isinstance(records, list):
        refuse("chain_observation_invalid")
    ds = []
    try:
        for record in records:
            if record.get("type") == "DS":
                ds.append(dns.rdata.from_text(1, dns.rdatatype.DS,
                          f'{record["keyTag"]} {record["algorithm"]} {record["digestType"]} {record["digest"]}'))
    except Exception:
        refuse("chain_observation_invalid")
    if not ds:
        refuse("chain_ds_missing")
    views = {}
    for authority in config["authorities"]:
        role = authority["role"]
        try:
            messages = {kind: source.query(authority["address"], owner, kind)
                        for kind, owner in [("DNSKEY", root), ("SOA", root),
                                            ("TLSA", "_443._tcp.app." + root)]}
            views[role] = verify_view(root, ds, messages, config["pin"], time.time())
        except Refusal as error:
            conditions.append(role + "_" + str(error))
        except Exception:
            conditions.append(role + "_dns_observation_unavailable")
    if source.tip() != before:
        refuse("chain_tip_changed")
    if len(views) == 2:
        primary, secondary = views["primary"], views["secondary"]
        serial = serial_condition(primary["serial"], secondary["serial"])
        if serial:
            conditions.append(serial)
        elif primary != secondary:
            conditions.append("zone_serving_records_disagree")
    return {"conditions": conditions}


def main():
    raw = sys.stdin.buffer.read(4097)
    if not raw or len(raw) > 4096:
        refuse("dns_configuration_invalid")
    config = json.loads(raw)
    if (not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", config["root"])
            or not re.fullmatch("[0-9a-f]{64}", config["pin"])
            or type(config["driver_port"]) is not int or not 1024 <= config["driver_port"] <= 65535
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]*", config["driver_reference"])
            or len(config["authorities"]) != 2
            or {entry["role"] for entry in config["authorities"]} != {"primary", "secondary"}):
        refuse("dns_configuration_invalid")
    addresses = [str(ipaddress.ip_address(entry["address"])) for entry in config["authorities"]]
    if len(set(addresses)) != 2:
        refuse("dns_configuration_invalid")
    return observe(config)


if __name__ == "__main__":
    try:
        result = main()
    except Refusal as error:
        result = {"conditions": [str(error)]}
    except Exception:
        result = {"conditions": ["dns_observation_unavailable"]}
    print(json.dumps(result, separators=(",", ":")))
