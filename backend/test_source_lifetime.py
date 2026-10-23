"""Active originals survive LRU eviction without pinning decoded documents."""
import copy
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import hashlib
import http.client
import json
import struct
import threading
import time
import unittest
from unittest import mock
import zlib

import server
import jobs


A, B, C = "a" * 32, "b" * 32, "c" * 32


@lru_cache(maxsize=32)
def source_bytes(index=0):
    # A real modern PIV with an opaque trailer: a regenerated file cannot
    # replace these exact unknown bytes, even when its visible scene is equal.
    scaffold = server.bridge.scaffold({"canvas_width": 640, "canvas_height": 480, "fps": 24})
    document = server.piv_codec.decode_piv_bytes(scaffold)
    figure = document["figure_types"][0]
    first = {"object_slot": 0, "unique_id": 1, "figure_type_id": 1, "scale": 1.0,
        "color_override_raw": 0, "field28": 0, "image_text_flags": 0, "opacity": 1.0,
        "angles": [segment["angle_rad"] for segment in figure["segments"]],
        "root_x": 100.0, "root_y": 150.0, "lengths": [], "bends": [],
        "len_flag": 0, "bend_flag": 0, "join": None}
    second = {**copy.deepcopy(first), "object_slot": 1, "unique_id": 2, "root_x": 250.0,
        "join": {"target_unique_id": 1, "target_object_slot": 0, "target_handle_id": 1}}
    frame = document["keyframes"][0]
    frame.update(objects=[first, second], object_draw_order=[1, 0],
        object_draw_order_unique_ids=[2, 1], duration_raw=4, inbetweens=3)
    hidden = copy.deepcopy(frame)
    hidden.update(duration_raw=0, inbetweens=-1)
    last = copy.deepcopy(frame)
    last.update(duration_raw=1, inbetweens=0)
    last["objects"][0]["root_x"] += 37.5
    document["keyframes"] = [frame, hidden, last]
    encoded = server.bridge.encode_piv_project(scaffold, document, force_rebuild=True)
    payload, _ = server.piv_codec._unpack_source(encoded)
    return zlib.compress(payload + b"\x00\xffunknown original bytes:" + str(index).encode("ascii"))


class SourceLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.store = server.ProjectStore(server.WORKSPACE)
        self.addCleanup(self.store.close)

    def evict_entries(self, store=None):
        store = store or self.store
        for index in range(server.MAX_CACHE_ENTRIES + 1):
            store.import_bytes(source_bytes(index + 1), "library.piv")
        self.assertLessEqual(len(store.sources), server.MAX_CACHE_ENTRIES)
        self.assertEqual(store.cache_bytes, sum(entry.retained_size for entry in store.sources.values()))

    def test_active_original_survives_entry_eviction_and_native_restart(self):
        raw = source_bytes()
        opened = self.store.import_bytes(raw, "active.piv", source_owner=A)
        entry = self.store.sources[opened["sourceId"]]
        retained = self.store.retained_sources[opened["sourceId"]]
        self.assertEqual(opened["sourceOwner"], A)
        self.assertIs(retained.data, entry.data)
        self.assertIsNone(retained.document_json)
        self.assertIsNone(retained.native_wire)
        expected_digest = server.document_digest(opened["document"])
        self.evict_entries()
        self.assertNotIn(opened["sourceId"], self.store.sources)
        source, metadata = self.store.source_record(opened["sourceId"])
        self.assertEqual(source, raw)
        self.assertEqual(json.loads(metadata), {"kind": "piv", "version": 5,
            "sha256": hashlib.sha256(raw).hexdigest(), "document_sha256": expected_digest,
            "document_digest_version": 3})
        exact, _ = self.store.export({**opened, "format": "piv"})
        self.assertEqual(exact, raw)
        native, _ = self.store.export({**opened, "format": "styk"})
        restarted = server.ProjectStore(server.WORKSPACE)
        self.addCleanup(restarted.close)
        reopened = restarted.import_bytes(native, "reopened.styk")
        exact, _ = restarted.export({**reopened, "format": "piv"})
        self.assertEqual(exact, raw)

    def test_edits_and_unknown_fields_survive_byte_budget_eviction(self):
        raw = source_bytes()
        opened = self.store.import_bytes(raw, "active.piv", source_owner=A)
        initial_size = self.store.cache_bytes
        self.store.max_cache = initial_size * 2 + 1024
        for index in range(5):
            self.store.import_bytes(source_bytes(index + 1), "library.piv")
        self.assertNotIn(opened["sourceId"], self.store.sources)
        self.assertLessEqual(self.store.cache_bytes, self.store.max_cache)
        edited = copy.deepcopy(opened["document"])
        edited["fps"] = 23.75
        edited["keyframes"][0]["objects"][0]["root_x"] += .25
        edited["keyframes"][0]["objects"][0]["angles"][0] += .125
        edited["keyframes"][0]["objects"][1]["lengths"] = [17.25] * len(edited["keyframes"][0]["objects"][1]["angles"])
        edited["opaque_future"] = {"values": [9007199254740993, 1.125, "01", True], "bytes": "\u0000\u00ff"}
        edited["_styk"] = {"format": "StykAnimate", "format_version": 1, "name": "Active draft", "future": {"keep": 1}}
        before = copy.deepcopy(edited)
        native, _ = self.store.export({**opened, "document": edited, "format": "styk"})
        self.assertEqual(edited, before)
        restarted = server.ProjectStore(server.WORKSPACE)
        self.addCleanup(restarted.close)
        reopened = restarted.import_bytes(native, "reopened.styk")
        self.assertEqual(server.bridge.source_bytes(reopened["document"]), raw)
        actual = {key: value for key, value in reopened["document"].items() if key != "_stykSource"}
        self.assertEqual(actual, edited)

    def test_native_wire_lease_does_not_retain_frame_payload(self):
        raw = source_bytes()
        wire = self.store.import_bytes(raw, "wire.piv", prefer_native=True, source_owner=A)
        size = struct.unpack_from("<I", wire, 8)[0]
        opened = json.loads(wire[12:12 + size])
        retained = self.store.retained_sources[opened["sourceId"]]
        self.assertEqual(opened["sourceOwner"], A)
        self.assertIsNone(retained.document_json)
        self.assertIsNone(retained.native_wire)
        self.assertIsNone(retained.digest, "Import must retain the existing deferred fingerprint")
        self.evict_entries()
        original, metadata = self.store.source_record(opened["sourceId"])
        self.assertEqual(original, raw)
        expected = server.piv_codec.decode_piv_bytes(raw, source_path="wire.piv")
        expected.pop("editable_paths", None)
        expected.pop("_codec", None)
        server.compact_media_aliases(expected)
        self.assertEqual(json.loads(metadata)["document_sha256"], server.document_digest(expected))

    def test_stk_original_and_definition_name_survive_eviction(self):
        document = self.store.import_bytes(source_bytes(), "source.piv")["document"]
        raw = server.bridge.export_stk({**document, "_exportFigureTypeId": 1})
        opened = self.store.import_bytes(raw, "named-figure.stk", source_owner=A)
        expected_digest = server.document_digest(opened["document"])
        self.evict_entries()
        original, metadata = self.store.source_record(opened["sourceId"])
        self.assertEqual(original, raw)
        self.assertEqual(json.loads(metadata)["document_sha256"], expected_digest)
        exact, _ = self.store.export({**opened, "format": "stk"})
        self.assertEqual(exact, raw)
        native, _ = self.store.export({**opened, "format": "styk"})
        fresh = server.ProjectStore(server.WORKSPACE)
        self.addCleanup(fresh.close)
        reopened = fresh.import_bytes(native, "reopened.styk")
        exact, _ = fresh.export({**reopened, "format": "stk"})
        self.assertEqual(exact, raw)
        self.assertEqual(reopened["document"]["figure_types"][1]["name"], "named-figure")

    def test_multiple_owners_share_one_original_until_last_release(self):
        raw = source_bytes()
        opened = self.store.import_bytes(raw, "active.piv", source_owner=A)
        self.assertTrue(self.store.retain_source(opened["sourceId"], B))
        self.assertTrue(self.store.retain_source(opened["sourceId"], A))
        self.assertEqual(self.store.retained_source_bytes, len(raw))
        self.assertEqual(len(self.store.retained_sources), 1)
        self.evict_entries()
        self.store.release_source(A)
        self.assertEqual(self.store.source_record(opened["sourceId"])[0], raw)
        self.store.release_source(B)
        self.store.release_source(B)
        self.assertEqual(self.store.retained_source_bytes, 0)
        self.assertEqual(self.store.retained_sources, {})
        with self.assertRaises(server.ApiError) as expired:
            self.store.source_record(opened["sourceId"])
        self.assertEqual(expired.exception.code, "source_expired")
        with self.assertRaises(server.ApiError) as expired:
            self.store.export({**opened, "format": "styk"})
        self.assertEqual(expired.exception.code, "source_expired")

    def test_renamed_reimport_preserves_active_original_fingerprint(self):
        raw = source_bytes()
        first = self.store.import_bytes(raw, "active-name.piv", source_owner=A)
        expected_digest = server.document_digest(first["document"])
        self.evict_entries()
        self.store.source_record(first["sourceId"])
        second = self.store.import_bytes(source_bytes(), "renamed-copy.piv", source_owner=B)
        self.assertEqual(second["filename"], "renamed-copy.piv")
        self.assertEqual(second["document"], first["document"])
        self.assertEqual(self.store.sources[first["sourceId"]].digest, expected_digest)
        self.assertIs(self.store.sources[first["sourceId"]].data, self.store.retained_sources[first["sourceId"]].data)
        for opened in (first, second):
            exact, _ = self.store.export({**opened, "format": "piv"})
            self.assertEqual(exact, raw)
            source, metadata = self.store.source_record(opened["sourceId"])
            self.assertEqual(source, raw)
            self.assertEqual(json.loads(metadata)["document_sha256"], expected_digest)

    def test_retention_limits_are_atomic_and_replacement_reuses_own_budget(self):
        raw = source_bytes()
        first = self.store.import_bytes(raw, "first.piv", source_owner=A)
        second = self.store.import_bytes(source_bytes(1), "second.piv")
        self.store.max_retained_sources = len(raw)
        with self.assertRaises(server.ApiError) as limit:
            self.store.retain_source(second["sourceId"], B)
        self.assertEqual(limit.exception.code, "source_retention_limit")
        self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
        self.assertEqual(self.store.retained_source_bytes, len(raw))
        self.store.max_retained_sources = len(source_bytes(1))
        self.assertTrue(self.store.retain_source(second["sourceId"], A))
        self.assertEqual(self.store.source_owners, {A: second["sourceId"]})
        self.assertNotIn(first["sourceId"], self.store.retained_sources)
        self.store.max_source_owners = 1
        with self.assertRaises(server.ApiError) as limit:
            self.store.retain_source(second["sourceId"], B)
        self.assertEqual(limit.exception.code, "source_owner_limit")
        self.assertEqual(self.store.source_owners, {A: second["sourceId"]})

    def test_replacing_one_shared_owner_cannot_drop_another_original(self):
        first = self.store.import_bytes(source_bytes(), "first.piv", source_owner=A)
        self.store.retain_source(first["sourceId"], B)
        second = self.store.import_bytes(source_bytes(1), "second.piv")
        self.store.max_retained_sources = len(source_bytes(1))
        with self.assertRaises(server.ApiError):
            self.store.retain_source(second["sourceId"], A)
        self.assertEqual(self.store.source_owners, {A: first["sourceId"], B: first["sourceId"]})
        self.store.max_retained_sources += len(source_bytes())
        self.store.retain_source(second["sourceId"], A)
        self.assertEqual(self.store.source_record(first["sourceId"])[0], source_bytes())
        self.assertEqual(self.store.source_record(second["sourceId"])[0], source_bytes(1))

    def test_failed_and_cancelled_imports_do_not_replace_existing_owner(self):
        first = self.store.import_bytes(source_bytes(), "first.piv", source_owner=A)
        with self.assertRaises(ValueError):
            self.store.import_bytes(b"broken", "broken.piv", source_owner=A)
        self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
        registry = jobs.JobRegistry()
        self.addCleanup(registry.close)
        retain = self.store._retain_source
        def cancel_before_publication(entry, owner):
            registry.cancel(C)
            return retain(entry, owner)
        with registry.enter(C), mock.patch.object(self.store, "_retain_source", side_effect=cancel_before_publication):
            with self.assertRaises(jobs.JobCancelled):
                self.store.import_bytes(source_bytes(1), "cancelled.piv", source_owner=A)
        self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
        self.evict_entries()
        self.assertEqual(self.store.source_record(first["sourceId"])[0], source_bytes())

    def test_closed_store_releases_originals_and_cannot_republish_imports(self):
        self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        self.store.close()
        self.store.close()
        self.assertEqual(self.store.source_owners, {})
        self.assertEqual(self.store.retained_sources, {})
        self.assertEqual(self.store.retained_source_bytes, 0)
        self.assertEqual(self.store.cache_bytes, 0)
        self.assertEqual(self.store.sources, {})
        with self.assertRaises(server.ApiError) as closed:
            self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        self.assertEqual(closed.exception.code, "backend_closed")

    def test_mutable_upload_cannot_change_retained_original(self):
        raw = source_bytes()
        buffer = bytearray(raw)
        opened = self.store.import_bytes(buffer, "mutable.piv", source_owner=A)
        buffer[:] = b"\xff" * len(buffer)
        self.evict_entries()
        self.assertEqual(self.store.source_record(opened["sourceId"])[0], raw)

    def test_shutdown_during_cached_native_wire_upgrade_cannot_republish_buffers(self):
        self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        prepare = server.import_wire.native_frame_wire
        def close_after_preparation(*args, **kwargs):
            parts = prepare(*args, **kwargs)
            self.store.close()
            return parts
        with mock.patch.object(server.import_wire, "native_frame_wire", side_effect=close_after_preparation):
            with self.assertRaises(server.ApiError) as closed:
                self.store.import_bytes(source_bytes(), "active.piv", prefer_native=True)
        self.assertEqual(closed.exception.code, "backend_closed")
        self.assertEqual(self.store.cache_bytes, 0)
        self.assertEqual(self.store.retained_source_bytes, 0)
        self.assertEqual(self.store.sources, {})
        self.assertEqual(self.store.retained_sources, {})

    def test_native_imports_do_not_retain_duplicate_original_storage(self):
        first = self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        native, _ = self.store.export({**first, "format": "styk"})
        reopened = self.store.import_bytes(native, "native.styk", source_owner=B)
        self.assertNotIn("sourceOwner", reopened)
        self.assertFalse(self.store.retain_source(reopened["sourceId"], B))
        self.assertNotIn(B, self.store.source_owners)
        self.assertEqual(self.store.retained_source_bytes, len(source_bytes()))


class SourceLifetimeHttpTests(unittest.TestCase):
    def setUp(self):
        self.store = server.ProjectStore(server.WORKSPACE)
        self.service = server.LocalServer(("127.0.0.1", 0), self.store, server.APP, "private-token")
        self.thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.service.shutdown()
        self.service.server_close()
        self.thread.join(5)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.service.server_port, timeout=30)
        try:
            connection.request(method, path, body=body, headers={"Authorization": "Bearer private-token", **(headers or {})})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_authenticated_import_lease_fetch_release_and_shutdown(self):
        raw = source_bytes()
        status, data = self.request("POST", "/api/import?filename=active.piv", raw,
            {"Content-Type": "application/octet-stream", "X-Styk-Source-Owner": A})
        self.assertEqual(status, 200, data)
        opened = json.loads(data)
        self.assertEqual(opened["sourceOwner"], A)
        for index in range(server.MAX_CACHE_ENTRIES + 1):
            self.store.import_bytes(source_bytes(index + 1), "library.piv")
        status, data = self.request("GET", "/api/source?id=" + opened["sourceId"])
        self.assertEqual(status, 200, data)
        self.assertEqual(data[:8], b"STYKSRC1")
        metadata_size = struct.unpack_from("<I", data, 8)[0]
        self.assertEqual(data[12 + metadata_size:], raw)
        status, data = self.request("POST", "/api/source/retain", server.encoded_json({"ownerId": B, "sourceId": opened["sourceId"]}))
        self.assertEqual(status, 200, data)
        self.assertEqual(json.loads(data), {"ok": True, "retained": True})
        status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": A}))
        self.assertEqual((status, data), (204, b""))
        self.service.shutdown()
        self.service.server_close()
        self.assertEqual(self.store.retained_source_bytes, 0)
        self.assertEqual(self.store.source_owners, {})

    def test_source_owner_validation_auth_and_remote_origin_rejection(self):
        opened = self.store.import_bytes(source_bytes(), "private.piv")
        source_path = "/api/source?id=" + opened["sourceId"]
        for headers, expected in (({"Authorization": "Bearer wrong-token"}, 401),
                                  ({"Origin": "https://remote.example"}, 403)):
            status, data = self.request("GET", source_path, headers=headers)
            self.assertEqual(status, expected)
            self.assertNotIn(source_bytes(), data)
        for path in ("/api/source/retain", "/api/source/release"):
            with self.subTest(path=path):
                status, data = self.request("POST", path, b"", {"Authorization": "Bearer wrong-token"})
                self.assertEqual(status, 401)
                self.assertNotIn(source_bytes(), data)
                status, data = self.request("POST", path, b"", {"Origin": "https://remote.example"})
                self.assertEqual(status, 403)
                status, data = self.request("POST", path, b"{}")
                self.assertEqual(status, 400, data)
                self.assertEqual(json.loads(data)["code"], "invalid_source_owner")
        status, data = self.request("POST", "/api/import?filename=active.piv", source_bytes(), {"X-Styk-Source-Owner": "invalid"})
        self.assertEqual(status, 400, data)
        self.assertEqual(self.store.source_owners, {})

    def test_source_release_remains_available_when_heavy_queue_is_full(self):
        self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        started, finish = threading.Event(), threading.Event()
        def hold(index):
            with self.service.jobs.enter(f"{1024 + index:032x}"):
                started.set()
                if index == 0:
                    self.assertTrue(finish.wait(5))
        with ThreadPoolExecutor(max_workers=16) as pool:
            first = pool.submit(hold, 0)
            self.assertTrue(started.wait(5))
            pending = [pool.submit(hold, index) for index in range(1, 16)]
            try:
                deadline = time.monotonic() + 5
                while self.service.jobs.snapshot()["queued"] != 15:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.005)
                status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": A}))
                self.assertEqual((status, data), (204, b""))
                self.assertEqual(self.store.source_owners, {})
                self.assertEqual(self.store.retained_source_bytes, 0)
                self.assertEqual(self.service.jobs.snapshot()["queued"], 15)
            finally:
                finish.set()
            first.result(5)
            for future in pending:
                future.result(5)

    def test_http_cancellation_precedes_release_without_late_owner_publication(self):
        first = self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        entered, finish = threading.Event(), threading.Event()
        retain = self.store._retain_source
        def hold_before_publication(entry, owner_id):
            entered.set()
            self.assertTrue(finish.wait(5))
            return retain(entry, owner_id)
        with mock.patch.object(self.store, "_retain_source", side_effect=hold_before_publication):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.request, "POST", "/api/import?filename=pending.piv", source_bytes(1),
                    {"X-Styk-Source-Owner": B, "X-Styk-Job-Id": C})
                try:
                    self.assertTrue(entered.wait(5))
                    status, data = self.request("POST", "/api/cancel?id=" + C, b"")
                    self.assertEqual((status, data), (204, b""))
                    status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": B}))
                    self.assertEqual((status, data), (204, b""))
                finally:
                    finish.set()
                with self.assertRaises((ConnectionError, http.client.RemoteDisconnected, OSError)):
                    pending.result(5)
        deadline = time.monotonic() + 5
        while self.service.jobs.snapshot()["active"]:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
        self.assertEqual(self.store.source_record(first["sourceId"])[0], source_bytes())

    def test_release_cancels_retaining_import_when_separate_cancel_was_not_received(self):
        first = self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        entered, finish = threading.Event(), threading.Event()
        retain = self.store._retain_source
        def hold_before_publication(entry, owner_id):
            entered.set()
            self.assertTrue(finish.wait(5))
            return retain(entry, owner_id)
        with mock.patch.object(self.store, "_retain_source", side_effect=hold_before_publication):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.request, "POST", "/api/import?filename=pending.piv", source_bytes(1),
                    {"X-Styk-Source-Owner": B, "X-Styk-Job-Id": C})
                try:
                    self.assertTrue(entered.wait(5))
                    status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": B, "jobId": C}))
                    self.assertEqual((status, data), (204, b""))
                finally:
                    finish.set()
                with self.assertRaises((ConnectionError, http.client.RemoteDisconnected, OSError)):
                    pending.result(5)
        deadline = time.monotonic() + 5
        while self.service.jobs.snapshot()["active"]:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.005)
        self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
        self.assertEqual(self.store.source_record(first["sourceId"])[0], source_bytes())

    def test_release_cancels_queued_import_before_its_upload_is_read(self):
        first = self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        started, finish, reads = threading.Event(), threading.Event(), []
        def hold_active():
            with self.service.jobs.enter("d" * 32):
                started.set()
                self.assertTrue(finish.wait(5))
        read_body = server.Handler._body
        def observed(handler, limit):
            reads.append(handler.headers.get("X-Styk-Job-Id"))
            return read_body(handler, limit)
        with ThreadPoolExecutor(max_workers=2) as pool, mock.patch.object(server.Handler, "_body", observed):
            active = pool.submit(hold_active)
            self.assertTrue(started.wait(5))
            pending = pool.submit(self.request, "POST", "/api/import?filename=pending.piv", source_bytes(1),
                {"X-Styk-Source-Owner": B, "X-Styk-Job-Id": C})
            try:
                deadline = time.monotonic() + 5
                while self.service.jobs.snapshot()["queued"] != 1:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(.005)
                status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": B, "jobId": C}))
                self.assertEqual((status, data), (204, b""))
                with self.assertRaises((ConnectionError, http.client.RemoteDisconnected, OSError)):
                    pending.result(5)
                self.assertNotIn(C, reads)
                self.assertEqual(self.store.source_owners, {A: first["sourceId"]})
                self.assertEqual(self.store.source_record(first["sourceId"])[0], source_bytes())
            finally:
                finish.set()
            active.result(5)

    def test_invalid_optional_job_cannot_release_an_active_original(self):
        first = self.store.import_bytes(source_bytes(), "active.piv", source_owner=A)
        for job_id in (None, "invalid", "f" * 33, 4):
            status, data = self.request("POST", "/api/source/release", server.encoded_json({"ownerId": A, "jobId": job_id}))
            self.assertEqual(status, 400, data)
            self.assertEqual(json.loads(data)["code"], "invalid_job")
            self.assertEqual(self.store.source_owners, {A: first["sourceId"]})


if __name__ == "__main__":
    unittest.main()
