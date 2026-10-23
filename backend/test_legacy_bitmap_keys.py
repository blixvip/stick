"""Colour-keyed legacy sprites convert to the same PNG bytes as the per-pixel reference."""
import base64
import itertools
import random
import struct
import unittest
import zlib

import server  # noqa: F401 - adds the codec directory to the import path
import piv_legacy


def reference_png(asset):
    """The previous per-pixel conversion, kept verbatim as the oracle."""
    key = asset.get("transparency_color_raw", asset.get("transparent_color_raw"))
    blob = base64.b64decode(asset["data_uri"].split(",", 1)[1])
    pixel_offset = struct.unpack_from("<I", blob, 10)[0]
    dib_size = struct.unpack_from("<I", blob, 14)[0]
    width, signed_height, planes, bits, compression = struct.unpack_from("<iiHHI", blob, 18)
    height = abs(signed_height)
    stride = ((width * bits + 31) // 32) * 4
    palette = []
    if bits <= 8:
        used = struct.unpack_from("<I", blob, 46)[0] or (1 << bits)
        palette_start = 14 + dib_size
        for index in range(used):
            blue, green, red = blob[palette_start + index * 4:palette_start + index * 4 + 3]
            palette.append((red, green, blue))
    key_rgb = (key & 255, key >> 8 & 255, key >> 16 & 255)
    rows = bytearray()
    for y in range(height):
        row = pixel_offset + (height - 1 - y if signed_height > 0 else y) * stride
        rows.append(0)
        for x in range(width):
            if bits <= 8:
                index = (blob[row + x * bits // 8] >> (8 - bits - (x * bits % 8))) & ((1 << bits) - 1)
                if index >= len(palette):
                    raise ValueError("Legacy sprite bitmap references an absent palette color")
                rgb = palette[index]
            else:
                pos = row + x * (bits // 8)
                blue, green, red = blob[pos:pos + 3]
                rgb = (red, green, blue)
            rows.extend((*rgb, 0 if rgb == key_rgb else 255))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def bmp(width, height, bits, rng, palette_size=None, top_down=False, key_share=.3, key=(10, 200, 30)):
    """A BI_RGB bitmap whose pixels repeat the key colour at the given share."""
    stride = ((width * bits + 31) // 32) * 4
    palette = b""
    if bits <= 8:
        count = palette_size if palette_size is not None else 1 << bits
        colors = [key] + [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(count - 1)]
        palette = b"".join(bytes((b, g, r, 0)) for r, g, b in colors)
    rows = bytearray()
    for _ in range(height):
        row = bytearray(stride)
        for x in range(width):
            if bits <= 8:
                limit = palette_size if palette_size is not None else 1 << bits
                index = 0 if rng.random() < key_share else rng.randrange(limit)
                byte, shift = x * bits // 8, 8 - bits - (x * bits % 8)
                row[byte] |= index << shift
            else:
                rgb = key if rng.random() < key_share else (rng.randrange(256), rng.randrange(256), rng.randrange(256))
                pos = x * (bits // 8)
                row[pos:pos + 3] = bytes((rgb[2], rgb[1], rgb[0]))
                if bits == 32:
                    row[pos + 3] = rng.randrange(256)
        rows += row
    offset = 14 + 40 + len(palette)
    header = struct.pack("<2sIHHI", b"BM", offset + len(rows), 0, 0, offset)
    dib = struct.pack("<IiiHHIIiiII", 40, width, -height if top_down else height, 1, bits, 0, len(rows), 2835, 2835,
                      palette_size if bits <= 8 and palette_size else 0, 0)
    blob = header + dib + palette + bytes(rows)
    return {"data_uri": "data:image/bmp;base64," + base64.b64encode(blob).decode("ascii"),
            "transparency_color_raw": key[0] | key[1] << 8 | key[2] << 16}


class LegacyBitmapKeyTests(unittest.TestCase):
    def test_every_depth_matches_the_per_pixel_conversion(self):
        rng = random.Random(4)
        for bits, width, height, top_down in itertools.product((1, 4, 8, 24, 32), (1, 3, 7, 16, 33), (1, 5), (False, True)):
            for key_share in (0, .4, 1):
                asset = bmp(width, height, bits, rng, top_down=top_down, key_share=key_share)
                expected = reference_png(dict(asset))
                piv_legacy._keyed_bitmap_png(asset)
                self.assertEqual(asset["data_url"], expected, (bits, width, height, top_down, key_share))
                self.assertTrue(asset["color_key_applied"])

    def test_absent_palette_colours_are_still_rejected(self):
        rng = random.Random(9)
        asset = bmp(9, 3, 8, rng, palette_size=4)
        blob = bytearray(base64.b64decode(asset["data_uri"].split(",", 1)[1]))
        offset = struct.unpack_from("<I", blob, 10)[0]
        blob[offset + 5] = 7  # outside the four-entry palette
        asset["data_uri"] = "data:image/bmp;base64," + base64.b64encode(bytes(blob)).decode("ascii")
        with self.assertRaisesRegex(ValueError, "absent palette color"):
            reference_png(dict(asset))
        with self.assertRaisesRegex(ValueError, "absent palette color"):
            piv_legacy._keyed_bitmap_png(asset)
        self.assertNotIn("data_url", asset)


if __name__ == "__main__":
    unittest.main()
