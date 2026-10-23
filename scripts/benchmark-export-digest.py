"""Compare existing whole-document and frame-streamed v3 fingerprints.

Run each mode in a fresh process. Decoding precedes the measured digest; no
production function is patched and no input is written. HTTP integration is
measured separately by benchmark-performance-desktop.mjs.
"""
import argparse
import ast
import gc
import hashlib
import json
import inspect
import math
from pathlib import Path
import platform
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import server
from profile_import import memory_snapshot
from server import checkpoint


def legacy_document_digest(document):
    """Frozen pre-streaming v3 encoder, retained only as a benchmark control."""
    def normalize(value):
        if isinstance(value, float):
            return int(value) if math.isfinite(value) and value.is_integer() else value
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [normalize(item) for item in value]
        return value
    semantic = normalize({k: v for k, v in document.items() if k not in ("_stykSource", "_styk", "_stykWeb")})
    for frame in semantic.get("keyframes", []):
        for obj in frame.get("objects", []):
            obj.pop("runtime_segments", None)
    return hashlib.sha256(json.dumps(semantic, sort_keys=True, ensure_ascii=True,
        allow_nan=False, separators=(",", ":")).encode("ascii")).hexdigest()


def historical_numbers(value):
    """Frozen pre-scalar-dispatch normalizer; frame streaming is unchanged."""
    if isinstance(value, float):
        return int(value) if math.isfinite(value) and value.is_integer() else value
    if isinstance(value, dict):
        checkpoint()
        return {key: historical_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        checkpoint()
        return [historical_numbers(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--mode", choices=["legacy_document_digest", "document_digest", "source_document_digest", "historical_numbers"], required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--profile", action="store_true", help="Attribute top-level normalization and JSON encoding; diagnostic timing only")
    args = parser.parse_args()
    source = args.source.read_bytes()
    source_hash = hashlib.sha256(source).hexdigest()
    source_size = len(source)
    store = server.ProjectStore(server.WORKSPACE)
    store.import_bytes(source, args.source.name, as_json=True, prefer_native=True)
    entry = next(iter(store.sources.values()))
    document = store._decode_canonical(entry)
    del source, entry, store
    gc.collect()
    before = memory_snapshot()
    encoder = legacy_document_digest if args.mode == "legacy_document_digest" else server.source_document_digest if args.mode == "historical_numbers" else getattr(server, args.mode)
    stages = {}
    if args.profile or args.mode == "historical_numbers":
        if args.mode == "legacy_document_digest":
            parser.error("Profile the current document/source digest, not the frozen legacy control")
        def measured(name, function):
            def wrapped(*arguments, **options):
                at = time.perf_counter()
                result = function(*arguments, **options)
                elapsed = (time.perf_counter()-at)*1000
                row = stages.setdefault(name, {"calls": 0, "wallMs": 0, "maxMs": 0})
                row["calls"] += 1
                row["wallMs"] += elapsed
                row["maxMs"] = max(row["maxMs"], elapsed)
                if name == "json":
                    row["characters"] = row.get("characters", 0) + len(result)
                return result
            return wrapped
        # The copied function resolves these two names locally. Its original
        # normalizer recurses in server's globals, avoiding a timing wrapper
        # around every scalar and preserving the production implementation.
        namespace = dict(vars(server))
        normalizer = historical_numbers if args.mode == "historical_numbers" else server._canonical_numbers
        namespace["_canonical_numbers"] = measured("normalize", normalizer) if args.profile else normalizer
        if args.profile:
            namespace["json"] = SimpleNamespace(dumps=measured("json", json.dumps))
        exec(compile(ast.parse(inspect.getsource(server.source_document_digest)), "profiled_source_digest", "exec"), namespace)
        encoder = namespace["source_document_digest"]
    started, cpu = time.perf_counter(), time.process_time()
    digest = encoder(document)
    cpu_ms, wall_ms = (time.process_time() - cpu) * 1000, (time.perf_counter() - started) * 1000
    report = {"mode": args.mode, "fixtureBytes": source_size, "fixtureSha256": source_hash,
        "digest": digest, "wallMs": wall_ms, "cpuMs": cpu_ms, "diagnosticProfile": args.profile, "stages": stages,
        "memoryBefore": before, "memoryAfter": memory_snapshot(),
        "python": platform.python_version(), "platform": platform.platform(),
        "implementationSha256": hashlib.sha256((ROOT / "backend/server.py").read_bytes()).hexdigest(),
        "benchmarkSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "limitations": ["OS peak counters include prior decoding; current working set is not peak allocation.",
            "Function timing excludes source decoding, HTTP, request parsing and file writes.",
            "A fresh process per mode isolates allocator history; OS caches and other activity remain uncontrolled."]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
