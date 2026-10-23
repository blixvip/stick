"""STK fitting must preserve native geometry and scale with valid topology."""
import copy
import itertools
import math
from pathlib import Path
import random
import struct
import unittest
from unittest import mock
import zlib

import server
from work_control import cancellation


def historical_points(segments):
    """Independent pre-linear fitting control, used only on small fixtures."""
    points = {0: (0.0, 0.0)}
    remaining = list(segments)
    for _ in range(len(remaining) + 1):
        pending = []
        for segment in remaining:
            if segment["parent_id"] not in points:
                pending.append(segment)
                continue
            x, y = points[segment["parent_id"]]
            a, length, bend = segment["angle_rad"], segment["length"], segment.get("bend_rad", 0)
            if abs(bend) < 1e-8:
                dx, dy = length * math.cos(a), length * math.sin(a)
            else:
                dx = length / bend * (math.sin(a + bend) - math.sin(a))
                dy = length / bend * (math.cos(a) - math.cos(a + bend))
            points[segment["segment_id"]] = (x + dx, y + dy)
        if not pending:
            break
        if len(pending) == len(remaining):
            raise server.piv_codec.PivError("STK contains missing parents or a cyclic topology")
        remaining = pending
    return points


def modern_stk(segments):
    # Explicit IDs permit valid records whose parent appears later in the file.
    # Ordinary lines/paint, implicit draw order, absent media/secondary paint.
    payload = bytearray(struct.pack("<BH", 1 | 2 | 4 | 8 | 16 | 128, len(segments)))
    for segment in segments:
        payload.extend(struct.pack("<HHfdf", segment["parent_id"], segment["segment_id"],
            segment["length"], segment["angle_rad"], 4.0))
    bends = [(index, segment.get("bend_rad", 0)) for index, segment in enumerate(segments)
        if segment.get("bend_rad", 0)]
    payload.extend(struct.pack("<H", len(bends)))
    for index, bend in bends:
        payload.extend(struct.pack("<Hd", index, bend))
    payload.extend(struct.pack("<H", 0))
    return b"\x79" + zlib.compress(payload)


def chain(count):
    return [{"segment_id": i, "parent_id": i - 1, "length": 1.25,
        "angle_rad": 0.0, "bend_rad": 0.0} for i in range(1, count + 1)]


class StkTopologyTests(unittest.TestCase):
    def test_exact_points_for_sparse_branches_curves_and_every_record_order(self):
        segments = [
            {"segment_id": 19, "parent_id": 0, "length": 100.25, "angle_rad": .15},
            {"segment_id": 3, "parent_id": 19, "length": 75.5, "angle_rad": -.75, "bend_rad": .2},
            {"segment_id": 47, "parent_id": 3, "length": 9.125, "angle_rad": 2.5, "bend_rad": -.4},
            {"segment_id": 5, "parent_id": 19, "length": 33.0, "angle_rad": -1.0, "bend_rad": 1e-9},
            {"segment_id": 11, "parent_id": 0, "length": 12.0, "angle_rad": 3.1, "bend_rad": 1e-8},
        ]
        for ordering in itertools.permutations(segments):
            with self.subTest(ids=[segment["segment_id"] for segment in ordering]):
                before = copy.deepcopy(ordering)
                self.assertEqual(server.bridge._stk_joint_points(ordering), historical_points(ordering))
                self.assertEqual(ordering, before)

    def test_real_stk_import_preserves_entire_report_and_authored_record_order(self):
        segments = [{**segment, "angle_rad": (segment["segment_id"] % 11 - 5) * .07,
            "bend_rad": -.035 if segment["segment_id"] % 5 == 0 else 0.0}
            for segment in chain(200)]
        shuffled = copy.deepcopy(segments)
        random.Random(9181).shuffle(shuffled)
        for ordering in (segments, list(reversed(segments)), shuffled):
            with self.subTest(first_id=ordering[0]["segment_id"]):
                source = modern_stk(ordering)
                path = Path("exact-topology.stk")
                with mock.patch.object(server.bridge, "_stk_joint_points", side_effect=historical_points):
                    expected = server.bridge.stk_document(path, source)
                actual = server.bridge.stk_document(path, source)
                self.assertEqual(actual, expected)
                self.assertEqual([segment["segment_id"] for segment in actual["figure_types"][1]["segments"]],
                    [segment["segment_id"] for segment in ordering])
                server.bridge.validate_document(actual)

    def test_long_reverse_chain_resolves_linearly_without_recursion(self):
        checks = 0
        class ObservedSegment(dict):
            def __getitem__(self, key):
                nonlocal checks
                if key == "parent_id":
                    checks += 1
                return super().__getitem__(key)
        count = 6000
        segments = [ObservedSegment(segment) for segment in reversed(chain(count))]
        points = server.bridge._stk_joint_points(segments)
        self.assertEqual(len(points), count + 1)
        self.assertEqual(points[count], (count * 1.25, 0.0))
        self.assertLessEqual(checks, count * 6, "A valid reverse chain must not repeatedly rescan unresolved parents")
        self.assertEqual([segment["segment_id"] for segment in segments], list(range(count, 0, -1)))

    def test_missing_parents_and_cycles_keep_the_fitting_error(self):
        fixtures = [
            [{**chain(1)[0], "parent_id": 99}],
            [{**chain(1)[0], "parent_id": 1}],
            [{**chain(1)[0], "parent_id": 2}, chain(2)[1]],
            [chain(1)[0], {**chain(2)[1], "parent_id": 99}],
        ]
        for segments in fixtures:
            with self.subTest(segments=segments):
                before = copy.deepcopy(segments)
                for resolve in (historical_points, server.bridge._stk_joint_points):
                    with self.assertRaisesRegex(server.piv_codec.PivError,
                            "^STK contains missing parents or a cyclic topology$"):
                        resolve(segments)
                self.assertEqual(segments, before)

    def test_modern_malformed_topology_is_still_rejected_by_the_parser(self):
        for segments in ([{**chain(1)[0], "parent_id": 9}],
                [{**chain(1)[0], "parent_id": 2}, chain(2)[1]]):
            with self.subTest(segments=segments), self.assertRaises(server.piv_codec.PivError):
                server.bridge.stk_document(Path("malformed-topology.stk"), modern_stk(segments))

    def test_cancellation_in_parent_first_fit_and_unresolved_parent_traversal(self):
        class Cancelled(Exception):
            pass
        for reverse, stop_at in ((False, 4), (True, 10)):
            segments = chain(1024)
            if reverse:
                segments.reverse()
            before = copy.deepcopy(segments)
            checks = 0
            def stop():
                nonlocal checks
                checks += 1
                if checks == stop_at:
                    raise Cancelled()
            with self.subTest(reverse=reverse), self.assertRaises(Cancelled), cancellation(stop):
                server.bridge._stk_joint_points(segments)
            self.assertEqual(checks, stop_at)
            self.assertEqual(segments, before)
            self.assertEqual(server.bridge._stk_joint_points(segments), historical_points(segments))


if __name__ == "__main__":
    unittest.main()
