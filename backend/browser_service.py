"""The Pivot codec without HTTP.

The desktop app and the development server reach the codec through server.py's
HTTP handler. A browser has no local server, so a Web Worker running Pyodide
calls this module instead. BrowserCodec.request() takes what the handler would
have read from the wire and returns what it would have written, over the same
ProjectStore, the same size rules and the same error mapping (server.py owns
those, so the two transports cannot drift).

Differences that follow from running inside a browser tab:

* No workspace. /api/open and /api/samples read files next to the app on a
  desktop; here they are unavailable and the editor loads files the person picks.
* One request at a time. The worker is single-threaded and requests queue in the
  host, so the handler's admission and cancellation machinery is not needed.
  Cancelling stops the worker; nothing here interrupts a running request.
* Smaller limits. WebAssembly memory is a shared 32-bit space, so a tab holds
  less than the 384 MiB codec cache the desktop uses.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import import_wire
import server

MIB = 1024 * 1024
WEB_MAX_SOURCE = 96 * MIB
WEB_MAX_DOCUMENT = 128 * MIB
WEB_MAX_CACHE = 160 * MIB

Response = tuple[int, dict[str, str], bytes]


class BrowserCodec:
    def __init__(self, *, max_source: int = WEB_MAX_SOURCE, max_document: int = WEB_MAX_DOCUMENT,
                 max_cache: int = WEB_MAX_CACHE):
        self.max_source, self.max_document = max_source, max_document
        # The root is only used to list and open workspace files, which this
        # transport never exposes.
        self.store = server.ProjectStore(Path("/"), max_cache=max_cache, max_retained_sources=max_source)

    def _limit(self, filename: str) -> int:
        return self.max_document if server.is_native_document(filename) else self.max_source

    @staticmethod
    def _json(status: int, value: object) -> Response:
        return status, {"Content-Type": "application/json; charset=utf-8"}, server.encoded_json(value)

    def request(self, method: str, target: str, headers: dict | None = None, body: bytes = b"") -> Response:
        """(status, headers, body) for one API request; never raises."""
        headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        try:
            return self._route(method.upper(), urlsplit(target), headers, bytes(body))
        except Exception as exc:  # noqa: BLE001 - every failure becomes a JSON error like the HTTP handler
            status, payload = server.error_response(exc)
            return self._json(status, payload)

    def _route(self, method: str, parsed, headers: dict, body: bytes) -> Response:
        query = parse_qs(parsed.query)
        path = parsed.path
        prefer_native = import_wire.CONTENT_TYPE in headers.get("accept", "")
        if method == "GET" and path == "/api/health":
            payload = server.health_payload({"active": 0, "queued": 0, "capacity": 1, "recentCancellations": 0},
                                            None, max_import=self.max_source)
            payload["host"] = "browser"
            return self._json(200, payload)
        if method == "GET" and path == "/api/samples":
            return self._json(200, {"ok": True, "samples": []})
        if method == "GET" and path == "/api/source":
            source_id = query.get("id", [""])[0]
            return 200, {"Content-Type": "application/octet-stream"}, server.source_record_payload(self.store, source_id)
        if method == "POST" and path == "/api/cancel":
            return 204, {"Content-Type": "application/json"}, b""
        if method == "POST" and path == "/api/import":
            name = query.get("filename", ["imported.piv"])[0]
            if len(body) > self._limit(name):
                raise server.ApiError(413, "body_too_large", "The request exceeds the configured size limit.")
            result = self.store.import_bytes(body, name, as_json=True, prefer_native=prefer_native,
                                             source_owner=headers.get("x-styk-source-owner"))
            kind = import_wire.CONTENT_TYPE if result.startswith(import_wire.MAGIC) else "application/json; charset=utf-8"
            return 200, {"Content-Type": kind}, result
        if method == "POST" and path == "/api/export":
            started = time.perf_counter()
            if len(body) > self.max_document:
                raise server.ApiError(413, "body_too_large", "The request exceeds the configured size limit.")
            request = server.decoded_json(body)
            timings = {"receive": 0.0, "parse": (time.perf_counter() - started) * 1000}
            if not isinstance(request, dict):
                raise server.ApiError(400, "invalid_request", "The request must be a JSON object.")
            data, name = self.store.export(request, timings=timings)
            timings["total"] = (time.perf_counter() - started) * 1000
            return 200, {"Content-Type": "application/octet-stream",
                         **server.response_metadata(filename=name, timings=timings, request_bytes=len(body))}, data
        if method == "POST" and path == "/api/open":
            raise server.ApiError(404, "workspace_unavailable", "Opening files by path needs the desktop app.")
        if method == "POST" and path in ("/api/source/retain", "/api/source/release"):
            if len(body) > 4096:
                raise server.ApiError(413, "body_too_large", "The request exceeds the configured size limit.")
            request = server.decoded_json(body)
            if not isinstance(request, dict):
                raise server.ApiError(400, "invalid_request", "The request must be a JSON object.")
            if path == "/api/source/retain":
                retained = self.store.retain_source(request.get("sourceId"), request.get("ownerId"))
                return self._json(200, {"ok": True, "retained": retained})
            self.store.release_source(request.get("ownerId"))
            return 204, {"Content-Type": "application/json"}, b""
        raise server.ApiError(404, "route_not_found", "Unknown codec endpoint.")


_codec: BrowserCodec | None = None


def handle(method: str, target: str, headers: dict | None = None, body: bytes = b"") -> Response:
    """Entry point for the Pyodide worker: one shared codec, created on first use."""
    global _codec
    if _codec is None:
        _codec = BrowserCodec()
    return _codec.request(method, target, headers, body)


def describe() -> str:
    """JSON description of this build, for the worker's ready message."""
    return json.dumps({"host": "browser", "maxSource": WEB_MAX_SOURCE, "maxDocument": WEB_MAX_DOCUMENT})
