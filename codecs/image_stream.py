"""Read self-contained image boundaries inside an already bounded PIV resource.

Record endpoints remain authoritative. JPEG APP/COM payloads may themselves
contain marker bytes, so only the JPEG grammar can identify its actual EOI.
"""
from __future__ import annotations


def jpeg_end(data: bytes, start: int, end: int) -> int:
    """Return the first complete JPEG's endpoint without copying its envelope."""
    if not 0 <= start < end <= len(data) or data[start:start + 2] != b'\xff\xd8':
        raise ValueError(f'Invalid JPEG header at byte {start}')
    pos, scan, has_scan = start + 2, False, False
    while pos < end:
        if scan:
            pos = data.find(b'\xff', pos, end)
            if pos < 0:
                break
        elif data[pos] != 0xff:
            raise ValueError(f'Invalid JPEG marker at byte {pos}')
        while pos < end and data[pos] == 0xff:
            pos += 1
        if pos >= end:
            break
        marker = data[pos]
        pos += 1
        if scan and (marker == 0 or 0xd0 <= marker <= 0xd7):
            continue  # Byte stuffing and restart markers within entropy data.
        if marker == 0xd9 and has_scan:
            return pos
        if marker in (0, 0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
            raise ValueError(f'Invalid JPEG marker at byte {pos - 1}')
        if marker == 1:
            continue
        if pos + 2 > end:
            break
        length = int.from_bytes(data[pos:pos + 2], 'big')
        if length < 2 or pos + length > end:
            raise ValueError(f'Invalid JPEG segment length at byte {pos}')
        pos += length
        # DNL may occur within a scan; other tables precede another SOS.
        scan = marker == 0xda or (scan and marker == 0xdc)
        has_scan |= marker == 0xda
    raise ValueError(f'Truncated JPEG at byte {start}')
