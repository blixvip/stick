"""One-request, loopback-only experiment; never installed as a codec endpoint."""
import argparse
import gc
import json
from http.server import HTTPServer
from pathlib import Path
import platform
import struct
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import server
import native_format
from profile_import import memory_snapshot


def decode_sections(body):
    # Benchmark framing only. Existing marker materialization supplies the
    # representation; a production protocol would need its own security tests.
    if len(body) < 12 or body[:8] != b'STYKXPR1':
        raise ValueError('Invalid benchmark envelope')
    size = struct.unpack_from('<I', body, 8)[0]
    if size > len(body) - 12:
        raise ValueError('Invalid benchmark header length')
    header = server.decoded_json(body[12:12 + size])
    sections, pos = [], 12 + size
    if len(header['sections']) != 2:
        raise ValueError('Invalid benchmark sections')
    for entry in header['sections']:
        length = entry['bytes']
        if type(length) is not int or length < 0 or pos + length > len(body) or entry['kind'] not in (1, 2):
            raise ValueError('Invalid benchmark section extent')
        sections.append((entry['kind'], memoryview(body)[pos:pos + length]))
        pos += length
    if pos != len(body):
        raise ValueError('Trailing benchmark bytes')
    return native_format._materialize(header['skeleton'], sections)


def equivalent(a, b):
    # JSON numbers may cross as integral floats, but booleans stay distinct.
    if type(a) in (int, float) and type(b) in (int, float):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(equivalent(v, b[k]) for k, v in a.items())
    if isinstance(a, list):
        return len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
    return a == b


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('mode', choices=('json', 'sections'))
    args = parser.parse_args()
    outcome = {}

    class Handler(server.Handler):
        def _project_post(self, parsed):
            if parsed.path != '/api/export':
                raise ValueError('Unexpected benchmark route')
            gc.collect()
            before = memory_snapshot()
            started, cpu = time.perf_counter(), time.process_time()
            body = self._body(server.MAX_DOCUMENT)
            received = time.perf_counter()
            request = server.decoded_json(body) if args.mode == 'json' else decode_sections(body)
            parsed_at = time.perf_counter()
            size = len(body)
            del body
            outcome.update(mode=args.mode, requestBytes=size, receiveMs=(received-started)*1000,
                parseMs=(parsed_at-received)*1000, cpuMs=(time.process_time()-cpu)*1000,
                memoryBefore=before, memoryAfter=memory_snapshot(), python=platform.python_version(),
                jsonEncoder=server._fast_json.__version__ if server._fast_json else 'stdlib')
            # The client clock stops before expensive parity/validation work.
            self.close_connection = True
            self._send(200, server.encoded_json(outcome), 'application/json')
            expected = server.decoded_json(args.request.read_bytes())
            if not equivalent(request, expected):
                raise AssertionError('Reconstruction changed an export value or type')
            server.bridge.validate_document(request['document'])
            outcome['valueParity'] = True
            outcome['validation'] = 'passed'

    # Use the actual bounded body reader, request checks and admission context.
    # A single connection avoids retained allocator state between conditions.
    with HTTPServer(('127.0.0.1', 0), Handler) as httpd:
        httpd.token = ''
        httpd.jobs = server.jobs.JobRegistry()
        print(json.dumps({'origin': f'http://127.0.0.1:{httpd.server_port}'}), flush=True)
        try:
            httpd.handle_request()
            if not outcome.get('valueParity'):
                raise AssertionError('Benchmark request failed verification')
            print(json.dumps(outcome), flush=True)
        finally:
            httpd.jobs.close()


if __name__ == '__main__':
    main()
