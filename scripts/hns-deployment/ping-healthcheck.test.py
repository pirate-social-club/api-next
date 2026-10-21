#!/usr/bin/env python3
import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("healthcheck_sender", Path(__file__).with_name("ping-healthcheck.py"))
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class SenderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / "managed-url"
        self.url = "https://hc-ping.com/00000000-0000-4000-8000-000000000001"
        self.file.write_text(self.url)
        self.file.chmod(0o600)

    def response(self, body=b"OK", status=200):
        opener = mock.MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = status
        response.read.return_value = body
        return opener

    def test_failure_uses_failure_endpoint_and_recovery_uses_success_endpoint(self):
        for state, suffix in [("failure", "/fail"), ("success", ""), ("start", "/start")]:
            client = self.response()
            sender.deliver(self.file, state, "authdns.service", opener=client)
            request = client.open.call_args.args[0]
            self.assertEqual(request.full_url, self.url + suffix)
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.data)["state"], state)
            self.assertEqual(client.open.call_args.kwargs["timeout"], 30)

    def test_http200_unknown_or_rate_limited_is_not_delivery_success(self):
        for body in [b"OK (not found)", b"OK (rate limited)", b"", b"unexpected"]:
            with self.assertRaises(sender.DeliveryError):
                sender.deliver(self.file, "failure", "authdns", opener=self.response(body))

    def test_refusal_does_not_leak_the_managed_url(self):
        client = mock.Mock()
        client.open.side_effect = urllib.error.HTTPError(self.url, 302, self.url, None, None)
        with self.assertRaises(sender.DeliveryError) as caught:
            sender.deliver(self.file, "failure", "authdns", opener=client)
        self.assertNotIn(self.url, str(caught.exception))
        client.open.assert_called_once()
        self.assertIsNone(sender.NoRedirect().redirect_request(None, None, 302, "redirect", {}, self.url))

    def test_invalid_or_nonprivate_input_is_refused_before_network(self):
        for value in ["http://hc-ping.com/00000000-0000-4000-8000-000000000001",
                      self.url + "/fail", self.url + "?create=1", self.url.replace("hc-ping.com", "invalid.example")]:
            self.file.write_text(value)
            client = self.response()
            with self.assertRaises(sender.DeliveryError):
                sender.deliver(self.file, "success", "authdns", opener=client)
            client.open.assert_not_called()
        self.file.write_text(self.url)
        self.file.chmod(0o644)
        with self.assertRaises(sender.DeliveryError):
            sender.target(self.file, "success")
        self.file.chmod(0o600)
        link = self.file.with_name("symlink")
        link.symlink_to(self.file)
        with self.assertRaises(sender.DeliveryError):
            sender.target(link, "success")


if __name__ == "__main__":
    unittest.main()
