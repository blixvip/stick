"""Regression for reported imports rejected at a figure-type transition."""
import copy
import struct
import unittest
import zlib
from unittest import mock

import server
import fast_decode
from test_fast_decode import canonical


def type_change_source(duration=4, incoming_duration=3, frame_count=3):
    """Make a real v5 file whose same UID changes to a different-sized rig.

    Patch only the outgoing duration after writing, so the fixture can also be
    generated with the old writer that rejected interpolated type changes.
    """
    document = server.piv_codec.decode_piv_bytes(server.bridge.scaffold(
        {'canvas_width': 640, 'canvas_height': 480, 'fps': 24}))
    custom = copy.deepcopy(document['figure_types'][0])
    custom.update(figure_type_id=2, name='Replacement', implicit=False,
                  segments=custom['segments'][:1], segment_count=1)
    custom.pop('segment_decode', None)
    document['figure_types'].append(custom)
    base = document['keyframes'][0]

    def pose(tid, uid, x, join=None):
        segments = document['figure_types'][tid-1]['segments']
        return dict(unique_id=uid, figure_type_id=tid, scale=1.,
                    color_override_raw=0, field28=0,
                    angles=[segment['angle_rad'] for segment in segments],
                    root_x=x, root_y=240., lengths=[segment['length'] for segment in segments],
                    bends=[0.] * len(segments), join=join)

    frames = []
    for index in range(frame_count):
        frame = copy.deepcopy(base)
        frame['duration_raw'] = 1
        frame['objects'] = [pose(1 if index == 0 else 2, 10, 150. + index * 40),
                            pose(2, 20, 350. + index * 40),
                            pose(2, 30, 0., dict(target_unique_id=10,
                                 target_object_slot=0, target_handle_id=1))]
        frame['object_draw_order'] = [2, 0, 1]
        frame['object_draw_order_unique_ids'] = [30, 10, 20]
        frames.append(frame)
    document['keyframes'] = frames
    source, _ = server.ProjectStore(server.WORKSPACE).export({'document': document, 'format': 'piv'})
    decoded = canonical.decode_piv_bytes(source)
    payload = bytearray(server.piv_codec._unpack_source(source)[0])
    for index, value in enumerate((duration, incoming_duration)):
        struct.pack_into('<H', payload, decoded['keyframes'][index]['record_offset'], value)
    return bytes(payload)


class TypeChangeTests(unittest.TestCase):
    def test_all_decoders_preserve_different_rigs_joins_and_hidden_keys(self):
        for outgoing in (0, 1, 4, 65535):
            for incoming in (0, 1, 3):
                source = type_change_source(outgoing, incoming)
                for encode in (bytes, zlib.compress):
                    with self.subTest(outgoing=outgoing, incoming=incoming, compressed=encode is zlib.compress):
                        data = encode(source)
                        expected = canonical.decode_piv_bytes(data)
                        actual = server.piv_codec.decode_piv_bytes(data)
                        self.assertEqual(actual, expected)
                        frames = actual['keyframes']
                        self.assertEqual([f['duration_raw'] for f in frames], [outgoing, incoming, 1])
                        self.assertEqual([f['objects'][0]['figure_type_id'] for f in frames], [1, 2, 2])
                        self.assertGreater(len(frames[0]['objects'][0]['angles']), len(frames[1]['objects'][0]['angles']))
                        self.assertEqual(frames[1]['objects'][2]['join']['target_unique_id'], 10)
                        self.assertEqual(actual['total_output_frames'], outgoing + incoming + 1)
                        for decoder in (fast_decode.scan_keyframes_python, fast_decode.scan_keyframes):
                            with mock.patch.object(fast_decode, 'scan_keyframes', decoder):
                                scanned = fast_decode.decode_for_native_wire(data)
                            self.assertEqual([f['duration_raw'] for f in scanned['keyframes']], [outgoing, incoming, 1])

    def test_large_project_import_and_piv_native_save_reopen_keep_every_frame(self):
        source = zlib.compress(type_change_source(frame_count=1129))
        store = server.ProjectStore(server.WORKSPACE)
        imported = store.import_bytes(source, 'type-change.piv')
        document = imported['document']
        self.assertEqual(len(document['keyframes']), 1129)
        self.assertEqual(document['total_output_frames'], 1134)
        unchanged, _ = store.export({**imported, 'format': 'piv'})
        self.assertEqual(unchanged, source)
        document['keyframes'][1]['objects'][0]['root_x'] += .25
        for format in ('piv', 'styk'):
            saved, _ = store.export({**imported, 'format': format})
            restored = server.ProjectStore(server.WORKSPACE).import_bytes(saved, f'restored.{format}')['document']
            self.assertEqual(len(restored['keyframes']), 1129)
            self.assertEqual([f['duration_raw'] for f in restored['keyframes']],
                             [f['duration_raw'] for f in document['keyframes']])
            for before, after in zip(document['keyframes'], restored['keyframes']):
                self.assertEqual(before['object_draw_order_unique_ids'], after['object_draw_order_unique_ids'])
                for original, reopened in zip(before['objects'], after['objects']):
                    for key in ('unique_id', 'figure_type_id', 'root_x', 'angles', 'lengths', 'bends', 'join'):
                        self.assertEqual(original[key], reopened[key])


if __name__ == '__main__':
    unittest.main()
