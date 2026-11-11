#!/usr/bin/env python3
"""Prepare an additive static-host Caddy/DNS plan. Never contact a live service."""

import argparse
import copy
import fnmatch
import hashlib
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib.parse import urlsplit


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def hostname(value):
    if len(value) > 253 or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in value.split(".")
    ):
        raise ValueError("hostname must be a canonical lowercase DNS name")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError("hostname must not be an IP literal")


def remote_path(value):
    if (
        not value.startswith("/")
        or str(PurePosixPath(value)) != value
        or ".." in PurePosixPath(value).parts
        or any(ord(c) < 32 for c in value)
    ):
        raise ValueError("certificate paths must be normalized absolute host paths")
    return value


def host_patterns(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("host", "sni"):
                if not isinstance(item, list) or not all(isinstance(x, str) for x in item):
                    raise ValueError("unsupported host/SNI matcher")
                yield from item
            else:
                yield from host_patterns(item)
    elif isinstance(value, list):
        for item in value:
            yield from host_patterns(item)


def prepare(config_bytes, zone_bytes, name, upstream, addresses, spki, cert_path, key_path, ttl=300):
    """Return a deterministic create-only plan and exact baseline rollback bytes."""
    hostname(name)
    parsed = urlsplit(upstream)
    target = hostname(parsed.hostname or "")
    if (
        upstream != f"https://{target}"
        or parsed.username or parsed.password or parsed.port not in (None, 443)
        or target == name
    ):
        raise ValueError("upstream must be a different HTTPS DNS origin with no path or credentials")
    if not re.fullmatch(r"[0-9a-f]{64}", spki):
        raise ValueError("SPKI digest must be lowercase SHA-256 hex")
    remote_path(cert_path)
    remote_path(key_path)
    if cert_path == key_path or not 60 <= ttl <= 86400:
        raise ValueError("invalid certificate paths or DNS TTL")
    ips = list(dict.fromkeys(str(ipaddress.ip_address(ip)) for ip in addresses))
    if not ips:
        raise ValueError("at least one gateway address is required")
    if any(ipaddress.ip_address(ip).is_unspecified or ipaddress.ip_address(ip).is_multicast for ip in ips):
        raise ValueError("unspecified and multicast gateway addresses are refused")

    config = json.loads(config_bytes)
    zone = json.loads(zone_bytes)
    zone_name = hostname(zone["name"].rstrip("."))
    if name != zone_name and not name.endswith("." + zone_name):
        raise ValueError("hostname is outside the supplied authoritative zone")
    for rrset in zone["rrsets"]:
        owner = rrset["name"].lower().rstrip(".")
        kind = rrset["type"].upper()
        if owner == name and kind in ("A", "AAAA", "CNAME", "DNAME"):
            raise ValueError("hostname already has address or alias records")
        if owner == name and kind == "NS" and name != zone_name:
            raise ValueError("hostname is a delegated child; use its child-zone snapshot")
        if kind == "DNAME" and name.endswith("." + owner):
            raise ValueError("hostname is below an existing DNAME")
        if owner == "_443._tcp." + name:
            raise ValueError("hostname already has TLS service records")

    servers = config["apps"]["http"]["servers"]
    selected = [(key, server) for key, server in servers.items() if ":443" in server.get("listen", [])]
    if len(selected) != 1:
        raise ValueError("expected exactly one existing :443 server")
    server_name, server = selected[0]
    if not server.get("routes") or not server.get("tls_connection_policies"):
        raise ValueError("existing HTTPS routes and TLS policies are required")
    if any(fnmatch.fnmatchcase(name, pattern.lower()) for pattern in host_patterns(config)):
        raise ValueError("hostname overlaps an existing explicit host or SNI matcher")

    candidate = copy.deepcopy(config)
    server = candidate["apps"]["http"]["servers"][server_name]
    tag = "static-host-" + digest(name.encode())[:16]
    if tag in json.dumps(config):
        raise ValueError("attachment certificate tag already exists")
    loaders = candidate["apps"]["tls"]["certificates"]["load_files"]
    if not isinstance(loaders, list):
        raise ValueError("expected an existing file certificate loader")
    existing = [entry for entry in loaders if entry.get("certificate") == cert_path]
    if existing:
        if len(existing) != 1 or existing[0].get("key") != key_path:
            raise ValueError("existing certificate path has a different key mapping")
        existing[0].setdefault("tags", []).append(tag)
    else:
        loaders.append({"certificate": cert_path, "key": key_path, "tags": [tag]})
    server["tls_connection_policies"].insert(0, {
        "match": {"sni": [name]}, "certificate_selection": {"any_tag": [tag]},
    })
    skip = server.setdefault("automatic_https", {}).setdefault("skip_certificates", [])
    if name not in skip:
        skip.append(name)
    proxy = {
        "handler": "reverse_proxy",
        "upstreams": [{"dial": target + ":443"}],
        "transport": {"protocol": "http", "tls": {"server_name": target}},
        "headers": {
            "request": {"set": {"Host": [target]}},
            "response": {"delete": ["Set-Cookie"]},
        },
    }
    server["routes"].insert(0, {
        "match": [{"host": [name]}], "terminal": True,
        "handle": [{"handler": "subroute", "routes": [
            {"match": [{"expression": {"expr": f'{{http.request.tls.server_name}} != "{name}"'}}],
             "handle": [{"handler": "static_response", "status_code": 421}], "terminal": True},
            {"match": [{"method": ["GET", "HEAD"]}], "terminal": True, "handle": [
                {"handler": "headers", "request": {"delete": [
                    "Authorization", "Proxy-Authorization", "Cookie", "Forwarded",
                    "X-Forwarded-*", "X-Pirate-*", "X-Hns-*", "CF-Access-*",
                ]}}, proxy,
            ]},
            {"handle": [{"handler": "static_response", "status_code": 405}], "terminal": True},
        ]}],
    })
    rrsets = []
    for version, kind in ((4, "A"), (6, "AAAA")):
        values = [ip for ip in ips if ipaddress.ip_address(ip).version == version]
        if values:
            rrsets.append({"name": name + ".", "type": kind, "ttl": ttl,
                           "changetype": "REPLACE", "records": [
                               {"content": ip, "disabled": False} for ip in values]})
    rrsets.append({"name": f"_443._tcp.{name}.", "type": "TLSA", "ttl": ttl,
                   "changetype": "REPLACE", "records": [{"content": "3 1 1 " + spki, "disabled": False}]})
    files = {
        "caddy.candidate.json": encoded(candidate), "caddy.rollback.json": config_bytes,
        "dns.changes.json": encoded({"rrsets": rrsets}), "dns.baseline.json": zone_bytes,
        "dns.rollback.json": encoded({"rrsets": [
            {"name": rr["name"], "type": rr["type"], "changetype": "DELETE"} for rr in rrsets]}),
    }
    plan = {
        "schema": "pirate-static-host-attachment/1", "hostname": name, "zone": zone_name,
        "upstream": upstream, "server": server_name, "tlsa": "3 1 1 " + spki,
        "gateway_addresses": ips, "certificate_path": cert_path, "key_path": key_path,
        "files_sha256": {key: digest(value) for key, value in files.items()},
        "state": "prepared-only", "native_browser_acceptance": "not performed",
        "required_before_apply": [
            "Fresh exclusive host and DNS custody; compare both live baseline hashes again",
            "Confirm name authority and absence of an existing persona or hostname assignment",
            "Validate certificate/key match and candidate with installed Caddy as its service account",
            "Confirm current zone signing key matches Handshake-published DS and both authorities work",
            "Review exact candidate and rollback; publish route and signed RRsets through maintained workflows",
            "Verify DNSSEC, served SPKI/TLSA, origin bytes, old routes, and installed target browsers",
        ],
    }
    files["plan.json"] = encoded(plan)
    return files


def certificate_spki(path, name):
    pem = path.read_bytes()
    if b"PRIVATE KEY" in pem:
        raise ValueError("only a public certificate is accepted")
    def openssl(*args, data=None):
        return subprocess.run(["openssl", *args], input=data, capture_output=True, check=True).stdout
    openssl("x509", "-in", str(path), "-checkhost", name, "-noout")
    openssl("x509", "-in", str(path), "-checkend", "604800", "-noout")
    public = openssl("x509", "-in", str(path), "-pubkey", "-noout")
    return digest(openssl("pkey", "-pubin", "-outform", "DER", data=public))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("config", "dns-zone", "public-cert"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("hostname", "upstream", "cert-path", "key-path"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--address", action="append", required=True)
    parser.add_argument("--ttl", type=int, default=300)
    parser.add_argument("--output", type=Path, help="write a new private local package; otherwise print plan only")
    args = parser.parse_args()
    name = hostname(args.hostname)
    files = prepare(args.config.read_bytes(), args.dns_zone.read_bytes(), name, args.upstream,
                    args.address, certificate_spki(args.public_cert, name),
                    args.cert_path, args.key_path, args.ttl)
    if args.output:
        args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
        for filename, data in files.items():
            with (args.output / filename).open("xb") as output:
                output.write(data)
    print(files["plan.json"].decode(), end="")


if __name__ == "__main__":
    main()
