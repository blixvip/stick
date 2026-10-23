"""The in-browser transport must behave exactly like the HTTP handler."""
from __future__ import annotations

import http.client
import json
import threading
import unittest
from pathlib import Path

import server
import browser_service
import import_wire


def blank_piv() -> bytes:
    return server.bridge.scaffold({"canvas_width": 640, "canvas_height": 480, "fps": 24})


def volatile(value):
    """Timing fields differ between runs; everything else must match."""
    if isinstance(value, dict):
        return {k: volatile(v) for k, v in value.items() if k != "timings"}
    if isinstance(value, list):
        return [volatile(v) for v in value]
    return value


class BrowserCodecTests(unittest.TestCase):
    def setUp(self):
        self.codec = browser_service.BrowserCodec()

    def call(self, method, target, body=b"", headers=None):
        return self.codec.request(method, target, headers, body)

    def test_health_reports_a_browser_host_without_a_workspace(self):
        status, headers, body = self.call("GET", "/api/health")
        health = json.loads(body)
        self.assertEqual((status, health["host"], health["ok"]), (200, "browser", True))
        self.assertEqual(health["formats"], ["piv", "stk", "styk", "stkz", "stykmov"])
        self.assertEqual(health["maxImportBytes"], browser_service.WEB_MAX_SOURCE)

    def test_workspace_routes_are_unavailable_not_broken(self):
        self.assertEqual(json.loads(self.call("GET", "/api/samples")[2]), {"ok": True, "samples": []})
        status, _, body = self.call("POST", "/api/open", b'{"path":"x.piv"}')
        self.assertEqual((status, json.loads(body)["code"]), (404, "workspace_unavailable"))

    def test_unknown_routes_and_methods_are_404(self):
        for method, target in (("GET", "/api/nope"), ("POST", "/api/health"), ("GET", "/api/import"), ("DELETE", "/api/export")):
            status, _, body = self.call(method, target)
            self.assertEqual((status, json.loads(body)["code"]), (404, "route_not_found"), (method, target))

    def test_cancel_is_a_successful_no_op(self):
        self.assertEqual(self.call("POST", "/api/cancel?id=abc")[0], 204)

    def test_import_export_roundtrip_returns_a_readable_pivot_file(self):
        status, _, body = self.call("POST", "/api/import?filename=blank.piv", blank_piv())
        self.assertEqual(status, 200)
        imported = json.loads(body)
        self.assertEqual((imported["ok"], imported["kind"]), (True, "piv"))
        request = json.dumps({"document": imported["document"], "format": "piv", "filename": "blank.piv",
                              "sourceId": imported["sourceId"]}).encode()
        status, headers, exported = self.call("POST", "/api/export", request)
        self.assertEqual(status, 200)
        self.assertIn("blank.piv", headers["Content-Disposition"])
        self.assertIn("Server-Timing", headers)
        self.assertEqual(headers["X-Styk-Request-Bytes"], str(len(request)))
        self.assertEqual(server.piv_codec.decode_piv_bytes(exported)["canvas_width"], 640)

    def test_the_retained_source_is_served_for_native_saves(self):
        imported = json.loads(self.call("POST", "/api/import?filename=blank.piv", blank_piv())[2])
        status, headers, body = self.call("GET", f"/api/source?id={imported['sourceId']}")
        self.assertEqual((status, body[:8]), (200, b"STYKSRC1"))
        status, _, body = self.call("GET", "/api/source?id=missing")
        self.assertEqual((status, json.loads(body)["code"]), (410, "source_expired"))

    def test_preferring_the_native_wire_returns_it(self):
        status, headers, body = self.call("POST", "/api/import?filename=blank.piv", blank_piv(), {"Accept": import_wire.CONTENT_TYPE})
        self.assertEqual(status, 200)
        if body.startswith(import_wire.MAGIC):
            self.assertEqual(headers["Content-Type"], import_wire.CONTENT_TYPE)

    def test_project_original_lease_survives_cache_eviction_and_releases_idempotently(self):
        owner = "a" * 32
        imported = json.loads(self.call("POST", "/api/import?filename=blank.piv", blank_piv(),
                                        {"X-Styk-Source-Owner": owner})[2])
        self.assertEqual(imported["sourceOwner"], owner)
        self.codec.store.sources.clear()
        self.codec.store.cache_bytes = 0
        status, _, body = self.call("GET", f"/api/source?id={imported['sourceId']}")
        self.assertEqual((status, body[:8]), (200, b"STYKSRC1"))
        request = json.dumps({"ownerId": owner}).encode()
        for _ in range(2):
            self.assertEqual(self.call("POST", "/api/source/release", request)[0], 204)
        self.assertEqual(self.call("GET", f"/api/source?id={imported['sourceId']}")[0], 410)

    def test_original_lease_controls_validate_requests_and_share_original_bytes(self):
        imported = json.loads(self.call("POST", "/api/import?filename=blank.piv", blank_piv())[2])
        owner = "b" * 32
        request = json.dumps({"sourceId": imported["sourceId"], "ownerId": owner}).encode()
        status, _, body = self.call("POST", "/api/source/retain", request)
        self.assertEqual((status, json.loads(body)), (200, {"ok": True, "retained": True}))
        self.assertEqual(self.codec.store.retained_source_bytes, len(blank_piv()))
        for path in ("/api/source/retain", "/api/source/release"):
            self.assertEqual(self.call("POST", path, b"[]")[0], 400)
            self.assertEqual(self.call("POST", path, b"x" * 4097)[0], 413)
            self.assertEqual(self.call("POST", path, b'{"ownerId":"wrong"}')[0], 400)

    def test_bad_files_become_json_errors_like_the_http_handler(self):
        status, headers, body = self.call("POST", "/api/import?filename=broken.piv", b"not a pivot file at all")
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body)["code"], "invalid_project")
        self.assertTrue(headers["Content-Type"].startswith("application/json"))

    def test_oversized_uploads_are_refused_before_decoding(self):
        small = browser_service.BrowserCodec(max_source=1024, max_document=2048)
        status, _, body = small.request("POST", "/api/import?filename=big.piv", None, b"x" * 1025)
        self.assertEqual((status, json.loads(body)["code"]), (413, "body_too_large"))
        status, _, body = small.request("POST", "/api/import?filename=big.styk", None, b"x" * 2049)
        self.assertEqual(status, 413)
        status, _, body = small.request("POST", "/api/export", None, b"x" * 2049)
        self.assertEqual(status, 413)

    def test_export_requires_a_json_object(self):
        status, _, body = self.call("POST", "/api/export", b"[1, 2]")
        self.assertEqual((status, json.loads(body)["code"]), (400, "invalid_request"))

    def test_module_entry_point_returns_plain_bytes_for_the_worker(self):
        status, headers, body = browser_service.handle("GET", "/api/health", {"Accept": "*/*"})
        self.assertEqual((status, type(body)), (200, bytes))


class HttpParityTests(unittest.TestCase):
    """The same request through the HTTP handler and the browser service."""

    @classmethod
    def setUpClass(cls):
        cls.http_server = server.LocalServer(("127.0.0.1", 0), server.ProjectStore(Path("/")), Path("."), "")
        cls.thread = threading.Thread(target=cls.http_server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        cls.thread.start()
        cls.port = cls.http_server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.http_server.shutdown()
        cls.http_server.server_close()

    def over_http(self, method, target, body=b"", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        connection.request(method, target, body=body or None, headers={"Content-Length": str(len(body)), **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        result = (response.status, response.getheader("Content-Type"), data)
        connection.close()
        return result

    def over_browser(self, method, target, body=b"", headers=None):
        status, out_headers, data = browser_service.BrowserCodec().request(method, target, headers, body)
        return status, out_headers.get("Content-Type"), data

    def assert_same(self, method, target, body=b"", headers=None):
        via_http, via_browser = self.over_http(method, target, body, headers), self.over_browser(method, target, body, headers)
        self.assertEqual(via_http[0], via_browser[0], (method, target))
        self.assertEqual(via_http[1], via_browser[1], (method, target))
        if via_http[1].startswith("application/json"):
            self.assertEqual(volatile(json.loads(via_http[2])), volatile(json.loads(via_browser[2])), (method, target))
        return via_http, via_browser

    def test_a_pivot_import_is_identical_on_both_transports(self):
        http_result, browser_result = self.assert_same("POST", "/api/import?filename=blank.piv", blank_piv())
        self.assertEqual(http_result[0], 200)

    def test_native_documents_and_failures_are_identical(self):
        piv = blank_piv()
        imported = json.loads(self.over_http("POST", "/api/import?filename=blank.piv", piv)[2])
        native = server.encoded_json({"document": imported["document"]})
        self.assert_same("POST", "/api/import?filename=copy.styk", native)
        self.assert_same("POST", "/api/import?filename=broken.piv", b"garbage garbage garbage")
        self.assert_same("POST", "/api/export", b"[]")
        self.assert_same("POST", "/api/nope")


if __name__ == "__main__":
    unittest.main()
