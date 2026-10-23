"""PIV source slots must survive unsorted and duplicate persistent IDs."""
import copy
import json
import struct
import unittest
import zlib
from unittest import mock

import server
import fast_decode
import import_wire
from test_fast_decode import canonical, frame_bytes


def identity_source():
    document = canonical.decode_piv_bytes(server.bridge.scaffold(
        {'canvas_width': 640, 'canvas_height': 480, 'fps': 24}))
    base = document['keyframes'][0]
    segments = document['figure_types'][0]['segments']
    frames = []
    for fi, duration in enumerate((4, 0, 3, 1)):
        frame = copy.deepcopy(base)
        objects = []
        for slot, uid in enumerate((10, 20, 30, 40, 50, 60)):
            objects.append(dict(unique_id=uid, figure_type_id=1, scale=1.,
                color_override_raw=0, field28=0,
                angles=[s['angle_rad'] for s in segments], lengths=[], bends=[],
                root_x=100. + 60*slot + fi, root_y=200.,
                join=dict(target_object_slot=2, target_handle_id=1) if slot == 4 else None))
        frame.update(duration_raw=duration, objects=objects,
                     object_draw_order=[4, 1, 5, 0, 3, 2])
        frame.pop('object_draw_order_unique_ids', None)
        frames.append(frame)
    document['keyframes'] = frames
    source, _ = server.ProjectStore(server.WORKSPACE).export({'document': document, 'format': 'piv'})
    parsed = canonical.decode_piv_bytes(source)
    payload = bytearray(server.piv_codec._unpack_source(source)[0])
    # Nonadjacent repeats; signed extremes; a hidden duplicate key; and IDs in
    # later keys which a streaming/per-frame allocator would accidentally steal.
    for fi, ids in enumerate(((0xFFFFFFFF, 10, 10, 10, 0, 0x80000000),
                             (0xFFFFFFFF, 10, 10, 10, 0, 0x80000000),
                             (1, 2, 3, 0, 0x80000000, 0xFFFFFFFF),
                             (10, 20, 30, 40, 50, 60))):
        for obj, uid in zip(parsed['keyframes'][fi]['objects'], ids):
            struct.pack_into('<I', payload, obj['record_offset'], uid)
    return bytes(payload)


class IdentityTests(unittest.TestCase):
    def test_all_document_decoders_share_collision_free_slot_preserving_recovery(self):
        for encode in (bytes, zlib.compress):
            source = encode(identity_source())
            expected = canonical.decode_piv_bytes(source)
            self.assertEqual(server.piv_codec.decode_piv_bytes(source), expected)
            for scanner in (fast_decode.scan_keyframes_python, fast_decode.scan_keyframes):
                with mock.patch.object(fast_decode, 'scan_keyframes', scanner):
                    actual, payload = fast_decode.decode_for_native_wire(source, with_payload=True)
                self.assertEqual(actual, expected)
                self.assertEqual(payload, server.piv_codec._unpack_source(source)[0])
            frames = expected['keyframes']
            self.assertEqual([f['duration_raw'] for f in frames], [4, 0, 3, 1])
            self.assertEqual(expected['total_output_frames'], 8)
            self.assertEqual([o['unique_id'] for o in frames[0]['objects']], [0xFFFFFFFF, 10, 4, 5, 0, 0x80000000])
            self.assertEqual([o['unique_id'] for o in frames[1]['objects']], [0xFFFFFFFF, 10, 6, 7, 0, 0x80000000])
            for fi, frame in enumerate(frames):
                self.assertEqual(len(frame['objects']), 6)
                self.assertEqual(frame['object_draw_order'], [4, 1, 5, 0, 3, 2])
                for slot, obj in enumerate(frame['objects']):
                    self.assertEqual(obj['object_slot'], slot)
                    self.assertEqual(obj['root_x'], 100. + 60*slot + fi)
                self.assertEqual(frame['objects'][4]['join']['target_object_slot'], 2)
                self.assertEqual(frame['objects'][4]['join']['target_unique_id'], frame['objects'][2]['unique_id'])
            self.assertEqual(len(expected['piv_identity_recovery']['objects']), 4)
            self.assertEqual(expected['import_warnings'][0]['code'], 'piv_duplicate_object_ids')
            self.assertIn('keyframes 1, 2', expected['import_warnings'][0]['message'])
            server.bridge.validate_document(expected)

    def test_native_wire_changes_only_audited_uid_fields_and_cache_order_is_irrelevant(self):
        source = zlib.compress(identity_source())
        for native_first in (True, False):
            store = server.ProjectStore(server.WORKSPACE)
            if not native_first: store.import_bytes(source, 'identities.piv')
            wire = store.import_bytes(source, 'identities.piv', prefer_native=True)
            size = struct.unpack_from('<I', wire, 8)[0]
            packet = json.loads(wire[12:12+size])
            actual = wire[12+size:]
            document = store.import_bytes(source, 'identities.piv')['document']
            payload = server.piv_codec._unpack_source(source)[0]
            start = packet['nativeFrames']['sourceOffset']
            expected = bytearray(payload[start:start+len(actual)])
            for repair in document['piv_identity_recovery']['objects']:
                struct.pack_into('<I', expected, repair['record_offset']-start, repair['unique_id'])
            self.assertEqual(actual, expected)
            reader = server.FastReader(actual)
            frames = fast_decode.read_keyframes(reader, document['figure_types'], document['background_slots'])
            for before, after in zip(document['keyframes'], frames):
                for a, b in zip(before['objects'], after['objects']):
                    self.assertEqual({k:v for k,v in a.items() if k not in ('record_offset','record_end')},
                                     {k:v for k,v in b.items() if k not in ('record_offset','record_end')})
                self.assertEqual(before['object_draw_order_unique_ids'], after['object_draw_order_unique_ids'])
            self.assertEqual(store.cache_bytes, sum(e.retained_size for e in store.sources.values()))
            bad = copy.deepcopy(document)
            bad['piv_identity_recovery']['objects'][0]['record_offset'] += 1
            with self.assertRaisesRegex(ValueError, 'does not match'):
                import_wire.native_frame_wire(bad, source, server.piv_codec._unpack_source, server.encoded_json)

    def test_unchanged_export_native_restart_and_edited_piv_keep_all_figures(self):
        source = zlib.compress(identity_source())
        store = server.ProjectStore(server.WORKSPACE)
        imported = store.import_bytes(source, 'identities.piv')
        self.assertEqual(store.export({**imported, 'format':'piv'})[0], source)
        saved = store.export({**imported, 'format':'styk'})[0]
        fresh = server.ProjectStore(server.WORKSPACE)
        reopened = fresh.import_bytes(saved, 'restored.styk')
        self.assertEqual(fresh.export({**reopened, 'format':'piv'})[0], source)
        document = imported['document']
        document['keyframes'][0]['objects'][2]['root_x'] += .25
        saved = store.export({**imported, 'format':'piv'})[0]
        restored = canonical.decode_piv_bytes(saved)
        self.assertNotIn('piv_identity_recovery', restored)
        for before, after in zip(document['keyframes'], restored['keyframes']):
            self.assertEqual(before['duration_raw'], after['duration_raw'])
            self.assertEqual(before['object_draw_order_unique_ids'], after['object_draw_order_unique_ids'])
            by_id = {o['unique_id']:o for o in after['objects']}
            self.assertEqual(len(by_id), len(before['objects']))
            for original in before['objects']:
                actual = by_id[original['unique_id']]
                for key in ('root_x', 'root_y', 'angles', 'lengths', 'bends', 'figure_type_id'):
                    self.assertEqual(original[key], actual[key])
                if original['join']:
                    self.assertEqual(original['join']['target_unique_id'], actual['join']['target_unique_id'])

    def test_recovery_never_masks_late_corruption_or_pose_budget(self):
        source = identity_source()
        parsed = canonical.decode_piv_bytes(source)
        for mutate in ('nan', 'order', 'truncate'):
            changed = bytearray(source)
            last = parsed['keyframes'][-1]
            if mutate == 'nan': struct.pack_into('<f', changed, last['objects'][-1]['record_offset']+6, float('nan'))
            elif mutate == 'order': struct.pack_into('<H', changed, last['objects'][-1]['record_end'], 65535)
            else: changed = changed[:last['objects'][-1]['record_offset']+10]
            for decode in (canonical.decode_piv_bytes, server.piv_codec.decode_piv_bytes, fast_decode.decode_for_native_wire):
                with self.assertRaises((canonical.PivError, server.piv_codec.PivError)) as error:
                    decode(bytes(changed))
                self.assertNotIsInstance(error.exception, server.piv_codec.PivIdentityError)
        with mock.patch.object(fast_decode, 'NATIVE_POSE_BUDGET', 4096):
            with self.assertRaisesRegex(server.piv_codec.PivError, 'pose budget'):
                fast_decode.decode_for_native_wire(source)
        # Failed scan state must not leak into the next full or native import.
        self.assertEqual(server.piv_codec.decode_piv_bytes(source), canonical.decode_piv_bytes(source))


if __name__ == '__main__':
    unittest.main()
