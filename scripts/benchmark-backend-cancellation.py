"""Measure cancelled source hashing and the following cold import over real HTTP.

The only benchmark hook observes entry to the ordinary fingerprint function.
It does not delay work or alter cancellation. Inputs remain read-only. Run with
a dense modern PIV and a small STK, in a fresh process for each implementation.
"""
import argparse
import hashlib
import http.client
import json
from pathlib import Path
import platform
import socket
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import server
from profile_import import memory_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("probe", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source, probe = args.source.read_bytes(), args.probe.read_bytes()
    assert args.source.suffix.lower() == ".piv" and args.probe.suffix.lower() == ".stk"
    fingerprint = lambda data: hashlib.sha256(data).hexdigest()
    paths = sorted(p for folder in ("backend", "codecs") for p in (ROOT / folder).rglob("*.py"))
    hashes = {p.relative_to(ROOT).as_posix(): fingerprint(p.read_bytes()) for p in paths}
    store = server.ProjectStore(args.source.parent)
    host = server.LocalServer(("127.0.0.1", 0), store, ROOT)
    serving = threading.Thread(target=host.serve_forever, daemon=True)
    serving.start()
    request = lambda: http.client.HTTPConnection("127.0.0.1", host.server_port, timeout=120)

    def import_probe():
        client = request()
        started = time.perf_counter()
        try:
            client.request("POST", "/api/import?filename=probe.stk", probe,
                           {"Content-Type": "application/octet-stream"})
            response = client.getresponse()
            body = response.read()
            assert response.status == 200, body[:300]
            result = json.loads(body)
            assert result["timings"]["cache_hit"] is False
            return (time.perf_counter() - started) * 1000, result["document"]
        finally:
            client.close()

    hashing, finished = threading.Event(), threading.Event()
    original = server.source_document_digest
    def observe(document, *values, **options):
        hashing.set()
        try:
            return original(document, *values, **options)
        finally:
            finished.set()

    cancelled = request()
    try:
        baseline_ms, baseline = import_probe()
        with store.lock:
            store.sources.clear()
            store.cache_bytes = 0
        store.import_bytes(source, args.source.name, as_json=True, prefer_native=True)
        entry = next(iter(store.sources.values()))
        assert entry.digest is None and entry.native_wire is not None
        server.source_document_digest = observe
        before = memory_snapshot()
        job_id = uuid.uuid4().hex
        cancelled.request("GET", "/api/source?id=" + entry.source_id,
                          headers={"X-Styk-Job-Id": job_id})
        assert hashing.wait(60), "Source hashing did not begin"
        cpu, started = time.process_time(), time.perf_counter()
        # A fetch abort destroys this connection. A half-close is insufficient:
        # ordinary HTTP clients may finish sending while still expecting output.
        cancelled.sock.shutdown(socket.SHUT_RDWR)
        cancelled.close()
        # Send the proposed explicit signal in both variants. The baseline
        # returns 404; a cancellation implementation must acknowledge it.
        control = request()
        try:
            control.request("POST", "/api/cancel?id=" + job_id, b"")
            response = control.getresponse()
            cancel_status = response.status
            response.read()
            assert cancel_status in (200, 204, 404), cancel_status
        finally:
            control.close()
        following_ms, following = import_probe()
        assert following == baseline, "Cancellation changed the following import"
        assert finished.wait(120), "Cancelled source job did not finish"
        report = {"sourceBytes": len(source), "sourceSha256": fingerprint(source),
            "probeBytes": len(probe), "probeSha256": fingerprint(probe),
            "baselineColdImportMs": baseline_ms, "importAfterCancelMs": following_ms,
            "cancelToCompletionMs": (time.perf_counter() - started) * 1000,
            "cpuAfterCancelMs": (time.process_time() - cpu) * 1000,
            "cancelledFingerprintPublished": entry.digest is not None,
            "cancelEndpointStatus": cancel_status,
            "probeDocumentSha256": fingerprint(json.dumps(following, sort_keys=True).encode()),
            "memoryBeforeHash": before, "memoryAfter": memory_snapshot(),
            "implementationHashes": hashes, "python": platform.python_version(),
            "platform": platform.platform(),
            "limitations": ["One source-service process and real loopback HTTP; no Electron/UI timing.",
                "Cancellation begins at the observed fingerprint stage, after decoding; the explicit cancellation endpoint is called in both variants.",
                "The following import uses identical bytes and filename with its cache entry removed.",
                "CPU includes both server request threads and the small probe client.",
                "Memory peaks include earlier decoding; OS caches and workstation activity are uncontrolled."]}
        assert hashes == {p.relative_to(ROOT).as_posix(): fingerprint(p.read_bytes()) for p in paths}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({k: report[k] for k in ("baselineColdImportMs", "importAfterCancelMs",
            "cancelToCompletionMs", "cpuAfterCancelMs", "cancelledFingerprintPublished")}), flush=True)
    finally:
        cancelled.close()
        host.shutdown()
        host.server_close()
        serving.join()
        server.source_document_digest = original


if __name__ == "__main__":
    main()
