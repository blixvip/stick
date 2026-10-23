"""Matched existing Python/C++ import experiment; no production code changes.

Run from the repository root with a .piv path and optional --out / --pairs.
The timed decode includes the ctypes wrapper, metadata packing and duration
materialization. It excludes HTTP, JS materialization and rendering; use the
companion desktop benchmark for that boundary. Input bytes are never written.
"""
import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import server
import fast_decode
from profile_import import memory_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--pairs", type=int, default=3)
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts/performance-architecture-audit/native-boundary.json")
    args = parser.parse_args()
    if not 1 <= args.pairs <= 20:
        parser.error("--pairs must be between 1 and 20")
    data = args.source.read_bytes()
    sha = lambda value: hashlib.sha256(value).hexdigest()
    original_env = os.environ.pop("STYK_DISABLE_NATIVE_SCAN", None)
    rows, expected = [], None
    try:
        status = fast_decode.native_scan.status()
        if not status["available"]:
            raise RuntimeError(f"Native comparison requires a built scanner: {status}")
        for pair in range(args.pairs):
            for mode in (["python", "cpp"] if pair % 2 == 0 else ["cpp", "python"]):
                os.environ["STYK_DISABLE_NATIVE_SCAN"] = "1" if mode == "python" else "0"
                gc.collect()
                scans = []
                original_scan = fast_decode.scan_keyframes
                def measured(*values, **options):
                    start = time.perf_counter()
                    result = original_scan(*values, **options)
                    scans.append((time.perf_counter() - start) * 1000)
                    return result
                fast_decode.scan_keyframes = measured
                cpu, start = time.process_time(), time.perf_counter()
                try:
                    document, payload = fast_decode.decode_for_native_wire(data, source_path=args.source.name, with_payload=True)
                finally:
                    fast_decode.scan_keyframes = original_scan
                elapsed, cpu_ms = (time.perf_counter() - start) * 1000, (time.process_time() - cpu) * 1000
                digest = [sha(server.encoded_json(document, validated=True)), sha(payload)]
                if expected is None:
                    expected = digest
                assert digest == expected, "Native headers, durations or frame payload differ"
                assert len(scans) == 1, "Fixture must exercise one native frame scan"
                rows.append({"pair": pair, "mode": mode, "decode_ms": elapsed, "cpu_ms": cpu_ms,
                    "scan_with_boundary_ms": scans[0], "memory": memory_snapshot(),
                    "header_sha256": digest[0], "payload_sha256": digest[1], "payload_bytes": len(payload),
                    "frames": len(document["keyframes"]), "figures": len(document["figure_types"])})
                del document, payload
        assert sha(args.source.read_bytes()) == sha(data), "Source file changed"
        report = {"python": platform.python_version(), "platform": platform.platform(), "source_name": args.source.name,
            "source_sha256": sha(data), "source_bytes": len(data), "native": status, "rows": rows,
            "limitations": ["Same process, alternating order; OS file cache and allocator are warm.",
                "Peak memory is lifetime high water, not a per-variant delta.",
                "C++ measured wrapper includes metadata and output conversion, not just the C call.",
                "No HTTP/browser/GPU work; no full parsed pose materialization."]}
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    finally:
        if original_env is None:
            os.environ.pop("STYK_DISABLE_NATIVE_SCAN", None)
        else:
            os.environ["STYK_DISABLE_NATIVE_SCAN"] = original_env


if __name__ == "__main__":
    main()
