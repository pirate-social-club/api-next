#!/usr/bin/env python3
"""Send explicit success/failure signals without exposing the managed URL."""
import argparse
import json
import os
import re
import socket
import stat
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


class DeliveryError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def target(path, state):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise DeliveryError("hosted check input must be a private owned regular file")
    value = path.read_text().strip()
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "https" or url.netloc != "hc-ping.com" or url.query or url.fragment
            or not re.fullmatch(r"/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", url.path)):
        raise DeliveryError("hosted check input is not a canonical HTTPS check URL")
    if state not in ("success", "failure", "start"):
        raise DeliveryError("unrecognized hosted signal state")
    return value + {"success": "", "failure": "/fail", "start": "/start"}[state]


def deliver(path, state, label, opener=None):
    if not re.fullmatch(r"[A-Za-z0-9@._:-]{1,250}", label):
        raise DeliveryError("invalid public check label")
    url = target(path, state)
    payload = json.dumps({"state": state, "label": label, "host": socket.gethostname(),
        "checked_at": datetime.now(timezone.utc).isoformat()}).encode()
    request = urllib.request.Request(url, data=payload, method="POST",
                                    headers={"Content-Type": "application/json"})
    client = opener or urllib.request.build_opener(NoRedirect())
    try:
        with client.open(request, timeout=30) as response:
            # The provider also uses HTTP200 for unknown/rate-limited checks.
            # Only its exact OK acknowledgement is successful delivery.
            if response.status != 200 or response.read(128).strip() != b"OK":
                raise DeliveryError("hosted check did not acknowledge the signal")
    except Exception:
        raise DeliveryError("hosted check delivery failed; URL and response withheld") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", choices=("success", "failure", "start"), required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    path = os.environ.get("HNS_HEALTHCHECK_URL_FILE", "")
    if not path or not Path(path).is_absolute():
        raise SystemExit("HNS_HEALTHCHECK_URL_FILE must name a private absolute file")
    try:
        if args.dry_run:
            target(Path(path), args.state)
            if not re.fullmatch(r"[A-Za-z0-9@._:-]{1,250}", args.label):
                raise DeliveryError("invalid public check label")
            print("validated hosted " + args.state + " configuration; no signal sent")
            return
        deliver(Path(path), args.state, args.label)
    except DeliveryError as error:
        raise SystemExit(str(error)) from None
    print("delivered hosted " + args.state + " signal")


if __name__ == "__main__":
    main()
