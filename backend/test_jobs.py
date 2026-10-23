"""Cancellation/admission must release capacity without changing codec semantics."""
from concurrent.futures import ThreadPoolExecutor
import copy
import http.client
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest import mock

import server
import jobs
from work_control import cancellation, checkpoint

A, B, C = "a" * 32, "b" * 32, "c" * 32


def until(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("Condition did not complete")
        time.sleep(.005)


def needs_sample(relative):
    """The Pivot sample corpus lives beside the repository and is not redistributed.
    A clean checkout skips these cases; STYK_REQUIRE_FIXTURES=1 runs them anyway."""
    return unittest.skipUnless(
        os.environ.get("STYK_REQUIRE_FIXTURES") == "1" or (server.WORKSPACE / relative).is_file(),
        f"requires {relative} beside the repository")


class RegistryTests(unittest.TestCase):
    def test_cancelled_queue_releases_capacity_without_entering_work(self):
        registry = jobs.JobRegistry(capacity=2)
        started, release = threading.Event(), threading.Event()
        entered = []
        def hold():
            with registry.enter(A):
                started.set()
                self.assertTrue(release.wait(5))
        def queued(key):
            with registry.enter(key):
                entered.append(key)
                checkpoint()
        with ThreadPoolExecutor(3) as pool:
            try:
                first = pool.submit(hold)
                self.assertTrue(started.wait(5))
                second = pool.submit(queued, B)
                until(lambda: registry.snapshot()["queued"] == 1)
                with self.assertRaises(jobs.JobError) as full:
                    with registry.enter(C):
                        self.fail("Full capacity admitted work")
                self.assertEqual(full.exception.code, "backend_busy")
                with self.assertRaises(jobs.JobError) as duplicate:
                    with registry.enter(A):
                        pass
                self.assertEqual(duplicate.exception.code, "duplicate_job")
                registry.cancel(B)
                with self.assertRaises(jobs.JobCancelled):
                    second.result(5)
                third = pool.submit(queued, C)
                until(lambda: registry.snapshot()["queued"] == 1)
                release.set()
                first.result(5); third.result(5)
            finally:
                release.set(); registry.close()
        self.assertEqual(entered, [C])
        self.assertEqual(registry.snapshot()["active"], 0)
        self.assertEqual(registry.snapshot()["queued"], 0)
        checkpoint()  # The exited thread/request context cannot leak.

    def test_early_cancellation_is_bounded_and_close_cancels_active_work(self):
        registry = jobs.JobRegistry(recent_capacity=3, recent_seconds=1)
        registry.cancel(A)
        with self.assertRaises(jobs.JobCancelled):
            with registry.enter(A):
                pass
        for value in range(20):
            registry.cancel(f"{value:032x}")
        self.assertEqual(registry.snapshot()["recentCancellations"], 3)
        aborted = []
        with self.assertRaises(jobs.JobCancelled):
            with registry.enter(B, abort_transport=lambda: aborted.append(True)):
                registry.close()
                checkpoint()
        self.assertEqual(aborted, [True])
        with self.assertRaises(jobs.JobError):
            with registry.enter(C):
                pass
        for value in ("", "wrong", A + "x", None, 4):
            with self.assertRaises(jobs.JobError):
                registry.cancel(value)

    def test_cancellation_orders_before_fingerprint_publication(self):
        store = server.ProjectStore(server.WORKSPACE)
        entry = server.Source(A, b"fixture", None, None, "test.piv", "piv", 5, 0)
        document = {"version": 5, "keyframes": [{"objects": []}], "opaque": [1.25, 9007199254740993]}
        expected = server.source_document_digest(document)
        registry = jobs.JobRegistry()
        def completed(_document):
            registry.cancel(A)
            return expected
        with mock.patch.object(store, "_decode_canonical", return_value=document):
            with registry.enter(A), mock.patch.object(server, "source_document_digest", side_effect=completed):
                with self.assertRaises(jobs.JobCancelled):
                    store._source_digest(entry)
            self.assertIsNone(entry.digest)
            self.assertEqual(store._source_digest(entry), expected)

    def test_hash_checkpoints_cancel_without_mutating_the_document(self):
        document = {"keyframes": [{"objects": [{"angles": list(range(100)), "runtime_segments": [1]}]} for _ in range(50)]}
        before = copy.deepcopy(document)
        checks = 0
        def stop():
            nonlocal checks
            checks += 1
            if checks == 25:
                raise jobs.JobCancelled()
        with self.assertRaises(jobs.JobCancelled), cancellation(stop):
            server.source_document_digest(document)
        self.assertEqual(checks, 25)
        self.assertEqual(document, before)
        self.assertEqual(server.source_document_digest(document), server.source_document_digest(before))

    @needs_sample("Pivot Animator v5/Animations/tween_pendulum.piv")
    def test_frame_and_full_writers_cancel_at_array_boundaries_without_mutation(self):
        import piv_document
        source = (server.WORKSPACE / "Pivot Animator v5/Animations/tween_pendulum.piv").read_bytes()
        document = server.ProjectStore(server.WORKSPACE).import_bytes(source, "test.piv")["document"]
        before = copy.deepcopy(document)
        original = piv_document._Writer.array
        for force in (False, True):
            with self.subTest(force_rebuild=force):
                registry = jobs.JobRegistry()
                def cancel_array(writer, *values):
                    registry.cancel(A)
                    return original(writer, *values)
                with registry.enter(A), mock.patch.object(piv_document._Writer, "array", cancel_array):
                    with self.assertRaises(jobs.JobCancelled):
                        server.bridge.encode_piv_project(source, document, force_rebuild=force)
                self.assertEqual(document, before)
                self.assertEqual(registry.snapshot()["active"], 0)

    @needs_sample("Pivot Animator v5/Figures/sheep.stk")
    def test_unknown_numeric_fields_remain_validated_and_cancel_in_bounded_batches(self):
        raw = (server.WORKSPACE / "Pivot Animator v5/Figures/sheep.stk").read_bytes()
        document = server.ProjectStore(server.WORKSPACE).import_bytes(raw, "sheep.stk")["document"]
        document["unknown_future"] = {"values": [9.125] * 5000}
        before = copy.deepcopy(document)
        registry, examined = jobs.JobRegistry(), 0
        original = server.math.isfinite
        def observed(value):
            nonlocal examined
            if value == 9.125:
                examined += 1
                if examined == 1:
                    registry.cancel(A)
            return original(value)
        with registry.enter(A), mock.patch.object(server.math, "isfinite", side_effect=observed):
            with self.assertRaises(jobs.JobCancelled):
                server.bridge.validate_document(document)
        self.assertLessEqual(examined, 1024)
        self.assertEqual(document, before)
        server.bridge.validate_document(document)
        for value in (float("nan"), float("inf"), float("-inf")):
            document["unknown_future"]["values"][2500] = value
            with self.assertRaisesRegex(server.piv_codec.PivError, "non-finite"):
                server.bridge.validate_document(document)


class HttpJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="styk-job-test-")
        self.store = server.ProjectStore(server.WORKSPACE)
        self.host = server.LocalServer(("127.0.0.1", 0), self.store, Path(self.directory.name))
        self.thread = threading.Thread(target=self.host.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.host.shutdown(); self.host.server_close(); self.thread.join()
        self.directory.cleanup()

    def client(self):
        return http.client.HTTPConnection("127.0.0.1", self.host.server_port, timeout=5)

    def request(self, method, path, body=None, headers=None):
        client = self.client()
        try:
            client.request(method, path, body, headers or {})
            response = client.getresponse()
            return response.status, response.read()
        finally:
            client.close()

    def test_cancelled_queued_upload_never_reads_its_body_and_control_remains_available(self):
        entered = threading.Event()
        def holding(_source):
            entered.set()
            for _ in range(1000):
                checkpoint(); time.sleep(.005)
            self.fail("Active job was not cancelled")
        reads = []
        original = server.Handler._body
        def observed(handler, limit):
            reads.append(handler.headers.get("X-Styk-Job-Id"))
            return original(handler, limit)
        with mock.patch.object(self.store, "source_record", side_effect=holding), mock.patch.object(server.Handler, "_body", observed):
            first, second = self.client(), self.client()
            try:
                first.request("GET", "/api/source?id=unused", headers={"X-Styk-Job-Id": A})
                self.assertTrue(entered.wait(5))
                second.putrequest("POST", "/api/import?filename=probe.stk")
                second.putheader("X-Styk-Job-Id", B)
                second.putheader("Content-Length", "1000000")
                second.endheaders()  # No body: admission must precede its read.
                until(lambda: self.host.jobs.snapshot()["queued"] == 1)
                self.assertEqual(self.request("GET", "/api/health")[0], 200)
                self.assertEqual(self.request("POST", "/api/cancel?id=" + B, b"")[0], 204)
                until(lambda: self.host.jobs.snapshot()["queued"] == 0)
                self.assertNotIn(B, reads)
                self.assertEqual(self.request("POST", "/api/cancel?id=" + A, b"")[0], 204)
                until(lambda: self.host.jobs.snapshot()["active"] == 0)
            finally:
                first.close(); second.close(); self.host.jobs.cancel(A); self.host.jobs.cancel(B)

    @needs_sample("Pivot Animator v5/Figures/sheep.stk")
    def test_cancel_interrupts_a_stalled_active_upload_and_next_import_is_valid(self):
        client = self.client()
        try:
            client.putrequest("POST", "/api/import?filename=probe.stk")
            client.putheader("Content-Length", "1000000"); client.putheader("X-Styk-Job-Id", A)
            client.endheaders()
            until(lambda: self.host.jobs.snapshot()["active"] == 1)
            self.assertEqual(self.request("POST", "/api/cancel?id=" + A, b"")[0], 204)
            until(lambda: self.host.jobs.snapshot()["active"] == 0)
        finally:
            client.close()
        raw = (server.WORKSPACE / "Pivot Animator v5/Figures/sheep.stk").read_bytes()
        status, body = self.request("POST", "/api/import?filename=sheep.stk", raw, {"X-Styk-Job-Id": B})
        self.assertEqual(status, 200, body[:200])
        self.assertTrue(json.loads(body)["document"]["figure_types"])

    def test_cancel_uses_existing_origin_authentication_and_half_close_is_not_cancellation(self):
        self.assertEqual(self.request("POST", "/api/cancel?id=" + A, b"", {"Origin": "https://example.test"})[0], 403)
        self.host.token = "local-test"
        self.assertEqual(self.request("POST", "/api/cancel?id=" + A, b"")[0], 401)
        self.assertEqual(self.request("POST", "/api/cancel?id=invalid", b"", {"Authorization": "Bearer local-test"})[0], 400)
        self.host.token = ""
        client = self.client()
        try:
            client.request("POST", "/api/open", b'{"path":"missing.piv"}', {"X-Styk-Job-Id": C})
            client.sock.shutdown(socket.SHUT_WR)
            response = client.getresponse()
            self.assertEqual(response.status, 404)
            self.assertEqual(json.loads(response.read())["code"], "file_not_found")
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
