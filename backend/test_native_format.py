import base64
import hashlib
import json
import struct
import unittest
import zlib
from unittest import mock

import native_format as native


def sectioned(skeleton, sections):
    payload = json.dumps(skeleton, ensure_ascii=False, separators=(',', ':')).encode()
    packed = zlib.compress(payload)
    records, blobs = [], []
    for kind, codec, raw, stored in sections:
        records.append(native.SECTION.pack(kind, codec, 0, 0, len(raw), len(stored), hashlib.sha256(raw).digest()))
        blobs.append(stored)
    return b''.join([native.HEADER.pack(b'STYK', 2, 1, 0, len(payload), len(packed), hashlib.sha256(payload).digest()),
                     struct.pack('<I', len(sections)), packed, *records, *blobs])


class NativeFormatTests(unittest.TestCase):
    def setUp(self):
        self.payload = json.dumps({'name': 'Scène 日本語', 'poses': [[0.125, 1, None, True]] * 10000}).encode()

    def test_lossless_compact_deterministic_both_kinds(self):
        for kind in ('styk', 'stkz', 'stykmov'):
            encoded = native.encode(self.payload, kind)
            self.assertEqual(encoded[:4], native.MAGIC[kind])
            self.assertEqual(native.decode(encoded, kind), self.payload)
            self.assertEqual(encoded, native.encode(self.payload, kind))
            self.assertLess(len(encoded), len(self.payload) / 20)

    def test_old_json_and_wrapper_remain_readable(self):
        for data in (self.payload, b'\xef\xbb\xbf \n' + self.payload, b'{"format":"stykanimate","version":1,"document":{}}'):
            self.assertEqual(native.decode(data), data)
            with self.assertRaises(ValueError):
                native.decode(data, 'stkz')

    def test_corruption_truncation_wrong_kind_and_future_version(self):
        valid = native.encode(self.payload, 'styk')
        for damaged in (b'', valid[:20], valid[:-1], valid + b'x',
                        valid[:4] + b'\x02' + valid[5:], valid[:5] + b'\x02' + valid[6:],
                        valid[:6] + b'\x01' + valid[7:],
                        valid[:24] + bytes([valid[24] ^ 1]) + valid[25:],
                        valid[:-1] + bytes([valid[-1] ^ 1])):
            with self.subTest(size=len(damaged)), self.assertRaises(ValueError):
                native.decode(damaged)
        with self.assertRaisesRegex(ValueError, 'extension'):
            native.decode(valid, 'stkz')

    def test_inflation_is_bounded_by_declared_and_absolute_sizes(self):
        packed = zlib.compress(self.payload)
        for size in (1, native.MAX_BYTES + 1):
            data = native.HEADER.pack(b'STYK', 1, 1, 0, size, len(packed), hashlib.sha256(self.payload).digest()) + packed
            with self.assertRaises(ValueError):
                native.decode(data)
        with self.assertRaises(ValueError):
            native.encode(self.payload, 'styk', max_bytes=100)

    def test_rejects_concatenated_compressed_streams(self):
        packed = zlib.compress(self.payload) + zlib.compress(b'{}')
        data = native.HEADER.pack(b'STYK', 1, 1, 0, len(self.payload), len(packed), hashlib.sha256(self.payload).digest()) + packed
        with self.assertRaises(ValueError):
            native.decode(data)


class NativeFormatV2Tests(unittest.TestCase):
    def test_zlib_sections_and_skeleton_are_bounded_and_strict(self):
        raw = b'x' * (1024 * 1024)
        packed = zlib.compress(raw)
        with self.assertRaisesRegex(ValueError, 'payload length'):
            native._unpack(1, packed, 32)
        self.assertEqual(native._unpack(1, packed, len(raw)), raw)
        for damaged in (packed[:-1], packed + b'x', packed + packed):
            with self.subTest(length=len(damaged)), self.assertRaises(ValueError):
                native._unpack(1, damaged, len(raw))
        skeleton = {'blob': 'S2S:0:0:3'}
        for stored in (zlib.compress(b'abc') + b'garbage', zlib.compress(b'abc') + zlib.compress(b'abc')):
            with self.assertRaisesRegex(ValueError, 'payload length'):
                native.decode(sectioned(skeleton, [(2, 1, b'abc', stored)]))

    def test_reserved_fields_kinds_codecs_and_lengths_are_rejected(self):
        encoded = sectioned({'a': 'S2B:u8:0:0:3'}, [(1, 0, b'abc', b'abc')])
        offset = native.HEADER.size + 4 + native.HEADER.unpack_from(encoded)[5]
        for relative in (2, 4, 56, 63):
            damaged = bytearray(encoded)
            damaged[offset + relative] = 1
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, 'Unsupported'):
                native.decode(damaged)
        for relative, value in ((0, 3), (1, 3)):
            damaged = bytearray(encoded)
            damaged[offset + relative] = value
            with self.assertRaisesRegex(ValueError, 'section kind|Unsupported'):
                native.decode(damaged)
        for relative in (8, 16):
            damaged = bytearray(encoded)
            struct.pack_into('<Q', damaged, offset + relative, 1 << 63)
            with self.assertRaisesRegex(ValueError, 'section table'):
                native.decode(damaged)

    def test_repeated_references_and_numeric_allocations_are_admitted_before_mutation(self):
        raw = b'x' * 450
        encoded = sectioned({'data': ['S2S:0:0:450'] * 8}, [(2, 1, raw, zlib.compress(raw))])
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native.decode(encoded, max_bytes=1024)
        skeleton = {'a': 'S2S:0:0:60', 'b': 'S2S:0:0:60'}
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native._materialize(skeleton, [(2, bytes(60))], max_materialized_bytes=200)
        self.assertEqual(skeleton, {'a': 'S2S:0:0:60', 'b': 'S2S:0:0:60'})
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native._materialize({'a': 'S2B:u8:0:0:32'}, [(1, bytes(32))], max_materialized_bytes=1000)

    def test_wide_finite_floats_and_existing_aliases_remain_exact(self):
        values = [1e300, -1e300, 1e-300, 1.25] * 16
        document = {'a': values, 'alias': values, 'independent': values[:], 'future': {'field': 'retained'}}
        skeleton, sections = native._lift(document)
        self.assertTrue(skeleton['a'].startswith('S2B:f64:'))
        decoded = native._materialize(skeleton, sections)
        self.assertEqual(decoded, document)
        self.assertIs(decoded['a'], decoded['alias'])
        self.assertIsNot(decoded['a'], decoded['independent'])
        decoded['a'][0] = 99
        self.assertEqual(decoded['independent'][0], 1e300)
        self.assertEqual(json.loads(native.decode(native.encode_v2(document, 'styk'))), document)

    def test_literal_markers_unknown_fields_and_drawing_payloads_survive(self):
        data = 'data:application/x-styk-tiles;base64,' + base64.b64encode(b'drawing pixels' * 10000).decode()
        document = {'styk_tiles': data, 'literal': 'S2B:f64:0:0:3', 'escaped': 'S2E:a',
                    'unknown': {'__proto__': {'retained': True}}, 'negative_zero': [-0.0] * 32}
        skeleton, _ = native._lift(document)
        self.assertTrue(skeleton['styk_tiles'].startswith('S2D:'))
        decoded = json.loads(native.decode(native.encode_v2(document, 'styk')))
        self.assertEqual(decoded, document)
        self.assertEqual(struct.pack('<d', decoded['negative_zero'][0]), struct.pack('<d', -0.0))

    def test_nonfinite_packed_values_and_invalid_ranges_are_rejected(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            raw = struct.pack('<d', value)
            with self.assertRaisesRegex(ValueError, 'non-finite'):
                native.decode(sectioned({'a': 'S2B:f64:0:0:1'}, [(1, 0, raw, raw)]))
        for marker in ('S2B:u8:0:0:9007199254740993', 'S2B:u8:0:1:1', 'S2S:0:99999999999999999:0'):
            with self.assertRaisesRegex(ValueError, 'section reference'):
                native._materialize({'a': marker}, [(1, b'')])

    def test_writer_rejects_oversized_sections_before_payload_decoding(self):
        encoded = base64.b64encode(bytes(50000)).decode()
        with mock.patch.object(native.base64, 'b64decode', side_effect=AssertionError('Decoded before admission')):
            with self.assertRaisesRegex(ValueError, 'uncompressed size'):
                native.encode_v2({'data_base64': encoded}, 'styk', max_bytes=1024)
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native.encode_v2({'a': [1] * 32}, 'styk', max_bytes=31)

    def test_sectioned_metadata_and_file_limits_are_independent_and_bounded(self):
        document = {'metadata': 'x' * 1500}
        encoded = native.encode_v2(document, 'styk', max_bytes=1024, max_skeleton_bytes=2048)
        self.assertLess(len(encoded), 1024)
        self.assertEqual(json.loads(native.decode(encoded, max_bytes=1024, max_skeleton_bytes=2048)), document)
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native.decode(encoded, max_bytes=1024, max_skeleton_bytes=1000)
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native.encode_v2(document, 'styk', max_bytes=1024, max_skeleton_bytes=1000)
        with self.assertRaisesRegex(ValueError, 'uncompressed size'):
            native.encode_v2({'array': [float(i) + .1 for i in range(200)]}, 'styk', max_bytes=1024)

    def setUp(self):
        shared = [i * 0.125 for i in range(64)]
        self.document = {
            'version': 5, 'fps': 12, 'canvas': {'width': 640, 'height': 480},
            'keyframes': [{'duration_raw': 2, 'objects': [
                {'figure_type_id': 1, 'angles': shared, 'lengths': [12.5] * 64,
                 'uids': [0, 255, 65536, 4294967295] * 12, 'neg': [-5, -3, 7] * 16,
                 'huge': [2 ** 60] * 40, 'join': {'target_object_slot': 1}},
                {'figure_type_id': 2, 'angles': shared}]}],
            'figure_types': [{'figure_type_id': 1, 'segments': [{'kind': 'line'}]}],
            '_stykSource': {'kind': 'piv', 'version': 5,
                'source_base64': base64.b64encode(b'original source bytes ' * 8000).decode('ascii')},
            'media': [{'name': 'a.png',
                'data_url': 'data:image/png;base64,' + base64.b64encode(b'PNGDATA' * 30000).decode('ascii')}],
            'title': 'S2B:looks like a marker', 'alt': 'S2E:already escaped',
        }

    def test_v2_round_trip_lossless_and_shared_identity(self):
        encoded = native.encode_v2(self.document, 'styk')
        self.assertEqual(encoded[:4], b'STYK')
        self.assertEqual(encoded[4], 2)
        decoded = json.loads(native.decode(encoded, 'styk'))
        self.assertEqual(decoded, self.document)

    def test_v2_marker_materialization_and_integrity(self):
        encoded = native.encode_v2(self.document, 'styk')
        # Skeleton resolves to the exact original values through markers.
        decoded = json.loads(native.decode(encoded, 'styk'))
        self.assertEqual(decoded['keyframes'][0]['objects'][0]['uids'][7], 4294967295)
        self.assertEqual(decoded['keyframes'][0]['objects'][0]['huge'], [2 ** 60] * 40)
        # Trailing data, truncation, and payload/section-table bit flips reject.
        mid = len(encoded) // 2
        for damaged in (encoded[:-1], encoded + b'x', encoded[:20],
                        encoded[:mid] + bytes([encoded[mid] ^ 1]) + encoded[mid + 1:]):
            with self.assertRaises(ValueError):
                native.decode(damaged, 'styk')
        with self.assertRaisesRegex(ValueError, 'extension'):
            native.decode(encoded, 'stkz')
        # v1 containers of the same document still decode identically.
        payload = json.dumps(self.document, separators=(',', ':')).encode()
        self.assertEqual(json.loads(native.decode(native.encode(payload, 'styk'))), self.document)

    def test_v2_size_beats_v1_on_numeric_documents(self):
        encoded_v2 = native.encode_v2(self.document, 'styk')
        payload = json.dumps(self.document, separators=(',', ':')).encode()
        encoded_v1 = native.encode(payload, 'styk')
        self.assertLess(len(encoded_v2), len(encoded_v1))


@unittest.skipIf(native._zstd is None, 'Optional zstandard codec is unavailable')
class ZstdAdmissionTests(unittest.TestCase):
    def test_known_content_size_is_rejected_before_decoder_allocation(self):
        packed = native._zstd.ZstdCompressor().compress(b'x' * 4096)
        with mock.patch.object(native._zstd, 'ZstdDecompressor', side_effect=AssertionError('Allocated before admission')):
            with self.assertRaisesRegex(ValueError, 'payload length'):
                native._unpack(2, packed, 32)

    def test_known_and_unknown_frames_reject_trailing_and_oversized_data(self):
        for known in (True, False):
            for checksum in (True, False):
                for raw in (b'', b'precise bytes', bytes(range(256)) * 1200, b'x' * 300000):
                    packed = native._zstd.ZstdCompressor(write_content_size=known, write_checksum=checksum).compress(raw)
                    self.assertEqual(native._unpack(2, packed, len(raw)), raw)
                    for damaged in (packed[:-1], packed + b'junk', packed + packed):
                        with self.assertRaises(ValueError):
                            native._unpack(2, damaged, len(raw))
                    with self.assertRaises(ValueError):
                        native._unpack(2, packed, len(raw) + 1)

    def test_oversized_windows_are_rejected_before_decoder_allocation(self):
        packed = native._zstd.ZstdCompressor(write_content_size=False).compress(b'exact')
        # Window descriptor is byte five in a frame without a content-size field.
        oversized = packed[:5] + bytes([0x98]) + packed[6:]
        with mock.patch.object(native._zstd, 'ZstdDecompressor', side_effect=AssertionError('Allocated before admission')):
            with self.assertRaisesRegex(ValueError, 'payload length'):
                native._unpack(2, oversized, 5)


if __name__ == '__main__':
    unittest.main()
