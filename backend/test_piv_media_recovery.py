"""Synthetic image-record regressions; no private user projects are required."""
import base64
import copy
import importlib
import json
from pathlib import Path
import struct
import unittest
import zlib
from unittest import mock

import server
import fast_decode
from image_stream import jpeg_end
from test_fast_decode import canonical, frame_bytes


def jpeg():
    # APP metadata deliberately contains a false EOI. Two scans exercise
    # progressive boundaries, stuffed entropy bytes and restart markers.
    return (b'\xff\xd8\xff\xe1\x00\x08meta\xff\xd9'
            b'\xff\xda\x00\x02abc\xff\x00\xd9\xff\xd0def'
            b'\xff\xc4\x00\x04hi\xff\xda\x00\x02xyz\xff\xd9')


def legacy_source(extra=b''):
    p = bytearray(struct.pack('<BIIBB', 4, 320, 240, 2, 1))
    p += struct.pack('<Q', len(p) + 8 + len(jpeg()) + len(extra)) + jpeg() + extra
    p += b'\x03sky' + struct.pack('<HIHBHI', 2, 1, 1, 1, 0, 40)
    return zlib.compress(p)


def missing_image_source(mode='unpatched', *, flags=190, name=b'Empty image'):
    p = bytearray(struct.pack('<BIIHH', 5, 320, 240, 1, 3))
    p += struct.pack('<BH', flags, 1)
    p += struct.pack('<HfdfB', 0, 50., 0., 1., 2)
    p += struct.pack('<HBBHH', 0, 0, 0, 0, 1)  # asset ref, flips, bends, images
    p += struct.pack('<iiii', 0, 200, 300, 200)
    pointer = len(p)
    if mode != 'omitted':
        p += struct.pack('<Q', pointer if mode == 'unpatched' else pointer + 8 if mode == 'empty' else mode)
    p += b'\0\0'  # no polygons
    if not flags & 16:
        p += b'\0\0'  # explicit segment order
    p += bytes([len(name)]) + name
    p += frame_bytes([{'uid': 77, 'tid': 2, 'x': 150}], media=True)
    p += struct.pack('<IB', 24, 0)
    return bytes(p), pointer


class PivMediaRecoveryTests(unittest.TestCase):
    def test_jpeg_envelope_keeps_record_endpoint_without_copying_old_payload(self):
        for extra in (b'', b'old project data\xff\xd9' * 10000):
            source = legacy_source(extra)
            for decode in (canonical.decode_piv_bytes, server.piv_codec.decode_piv_bytes,
                           fast_decode.decode_for_native_wire):
                doc = decode(source)
                bg = doc['backgrounds'][0]
                self.assertEqual(base64.b64decode(bg['data_url'].split(',')[1]), jpeg())
                self.assertEqual(bg['source_size'], 8 + len(jpeg()) + len(extra))
                self.assertEqual(bg['name'], 'sky')
                self.assertEqual(len(doc['keyframes']), 1)
                self.assertEqual(doc['fps'], 25)
                self.assertEqual(doc['validation']['payload_consumed'], len(zlib.decompress(source)))
            store = server.ProjectStore(server.WORKSPACE)
            imported = store.import_bytes(source, 'legacy.piv')
            output, _ = store.export({**imported, 'format': 'piv'})
            self.assertEqual(output, source)
            imported['document']['canvas_width'] += 10
            changed, _ = store.export({**imported, 'format': 'piv'})
            restored = server.piv_codec.decode_piv_bytes(changed)
            self.assertEqual(restored['canvas_width'], 330)
            self.assertEqual(restored['keyframes'][0]['background_id'], 1)

    def test_jpeg_truncation_markers_and_segment_lengths_stay_strict(self):
        data = jpeg()
        self.assertEqual(jpeg_end(data + b'junk', 0, len(data) + 4), len(data))
        for end in range(len(data)):
            with self.subTest(end=end), self.assertRaises(ValueError):
                jpeg_end(data, 0, end)
        for bad in (b'\xff\xd8\xff\xd9', b'\xff\xd8junk\xff\xd9',
                    b'\xff\xd8\xff\xe1\0\1\xff\xd9', b'\xff\xd8\xff\xe1\xff\xff'):
            with self.assertRaises(ValueError):
                jpeg_end(bad, 0, len(bad))

    def test_missing_images_preserve_objects_and_share_json_native_recovery(self):
        for mode in ('unpatched', 'omitted', 'empty'):
            raw, pointer = missing_image_source(mode)
            for source in (raw, zlib.compress(raw)):
                with self.subTest(mode=mode, compressed=source is not raw):
                    doc = server.piv_codec.decode_piv_bytes(source)
                    self.assertEqual(doc, canonical.decode_piv_bytes(source))
                    wire_doc = fast_decode.decode_for_native_wire(source)
                    self.assertEqual(wire_doc['figure_types'], doc['figure_types'])
                    self.assertEqual(wire_doc['piv_missing_images'], doc['piv_missing_images'])
                    asset = doc['figure_types'][1]['image_assets'][0]
                    self.assertTrue(base64.b64decode(asset['data_base64']).startswith(b'\x89PNG\r\n\x1a\n'))
                    self.assertTrue(asset['missing_image_data'])
                    self.assertEqual(asset['anchor_length'], 300)
                    self.assertEqual(doc['keyframes'][0]['objects'][0]['unique_id'], 77)
                    self.assertEqual(doc['keyframes'][0]['objects'][0]['figure_type_id'], 2)
                    self.assertEqual(doc['import_warnings'][0]['code'], 'piv_missing_image_data')

    def test_missing_image_roundtrips_keep_original_and_allow_edits(self):
        for mode in ('unpatched', 'omitted'):
            source = zlib.compress(missing_image_source(mode)[0])
            store = server.ProjectStore(server.WORKSPACE)
            store.import_bytes(source, 'image.piv', prefer_native=True)
            imported = store.import_bytes(source, 'image.piv')
            self.assertEqual(store.export({**imported, 'format': 'piv'})[0], source)
            native, _ = store.export({**imported, 'format': 'styk'})
            restarted = server.ProjectStore(server.WORKSPACE)
            reopened = restarted.import_bytes(native, 'image.styk')
            self.assertEqual(restarted.export({**reopened, 'format': 'piv'})[0], source)
            document = copy.deepcopy(imported['document'])
            document['keyframes'][0]['objects'][0]['root_x'] = 123.5
            changed, _ = store.export({'document': document, 'sourceId': imported['sourceId'], 'format': 'piv'})
            restored = server.piv_codec.decode_piv_bytes(changed)
            self.assertEqual(restored['keyframes'][0]['objects'][0]['root_x'], 123.5)
            self.assertEqual(len(restored['figure_types']), 2)
            self.assertEqual(restored['figure_types'][1]['image_assets'][0]['data_base64'],
                             document['figure_types'][1]['image_assets'][0]['data_base64'])

    def test_recovery_does_not_accept_arbitrary_pointers_or_broken_following_records(self):
        _, pointer = missing_image_source()
        for mode in (0, pointer - 1, pointer + 1, pointer + 7, 2**64 - 1):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                server.piv_codec.decode_piv_bytes(missing_image_source(mode)[0])
        for name in (b'', b'\x01bad'):
            with self.assertRaises(ValueError):
                server.piv_codec.decode_piv_bytes(missing_image_source('omitted', name=name)[0])
        raw, _ = missing_image_source('omitted')
        for end in range(len(raw) - 5):
            with self.subTest(end=end), self.assertRaises(ValueError):
                server.piv_codec.decode_piv_bytes(raw[:end])
        bad = bytearray(raw)
        struct.pack_into('<I', bad, len(bad) - 5, 0)
        with self.assertRaises(ValueError):
            fast_decode.decode_for_native_wire(bytes(bad))

    def test_bridge_uses_the_selected_codec_bundle(self):
        for name in ('piv_codec', 'piv_full_writer', 'piv_migrate', 'piv_side_tables',
                     'piv_legacy', 'piv_legacy_v4', 'pivot_decoder', 'image_stream'):
            self.assertEqual(Path(importlib.import_module(name).__file__).resolve().parent, server.TOOLS)

    def test_source_fingerprint_does_not_depend_on_json_transport_capacity(self):
        source = missing_image_source()[0]
        store = server.ProjectStore(server.WORKSPACE)
        wire = store.import_bytes(source, 'large.piv', prefer_native=True)
        length = struct.unpack_from('<I', wire, 8)[0]
        packet = json.loads(wire[12:12 + length])
        entry = store.sources[packet['sourceId']]
        expected = store._decode_canonical(entry)
        with mock.patch.object(server, 'MAX_DOCUMENT', 1):
            with self.assertRaises(server.ApiError):
                store._canonical_json(entry)
            raw, meta = store.source_record(packet['sourceId'])
        self.assertEqual(raw, source)
        self.assertEqual(json.loads(meta)['document_sha256'], server.document_digest(expected))
        self.assertIsNone(entry.document_json)
        with mock.patch.object(store, '_decode_canonical', side_effect=AssertionError('digest should be cached')):
            self.assertEqual(store.source_record(packet['sourceId']), (raw, meta))

    def test_streamed_fingerprint_preserves_numeric_and_opaque_field_semantics(self):
        for source in (missing_image_source()[0], legacy_source()):
            doc = server.piv_codec.decode_piv_bytes(source)
            doc.update(opaque={'zero': -0., 'integer': 1., 'fraction': .125, 'boolean': True,
                               'wide': 2**65, 'text': '\u2603', 'runtime_segments': ['keep']})
            doc['keyframes'][0]['objects'].append({'runtime_segments': ['omit'], 'root_x': -0.})
            before = copy.deepcopy(doc)
            self.assertEqual(server.source_document_digest(doc), server.document_digest(doc))
            self.assertEqual(doc, before)


if __name__ == '__main__':
    unittest.main()
