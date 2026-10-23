"""Isolate validation CPU overhead on the same decoded document and job context."""
import argparse
import ast
import gc
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import server
import jobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--control-ref", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    raw = args.source.read_bytes()
    old = subprocess.check_output(["git", "show", args.control_ref + ":codecs/codec_bridge.py"], cwd=ROOT)
    function = next(node for node in ast.parse(old).body
        if isinstance(node, ast.FunctionDef) and node.name == "validate_document")
    function.name = "validate_control"
    namespace = dict(vars(server.bridge))
    exec(compile(ast.Module(body=[function], type_ignores=[]), "control_validation", "exec"), namespace)
    store = server.ProjectStore(server.WORKSPACE)
    store.import_bytes(raw, args.source.name, as_json=True, prefer_native=True)
    document = store._decode_canonical(next(iter(store.sources.values())))
    registry, rows = jobs.JobRegistry(), []
    for mode in ("control", "candidate", "candidate", "control"):
        gc.collect()
        validate = namespace["validate_control"] if mode == "control" else server.bridge.validate_document
        with registry.enter():
            started, cpu = time.perf_counter(), time.process_time()
            validate(document)
            rows.append({"mode": mode, "wallMs": (time.perf_counter() - started) * 1000,
                "cpuMs": (time.process_time() - cpu) * 1000})
    digest = lambda data: hashlib.sha256(data).hexdigest()
    report = {"sourceBytes": len(raw), "sourceSha256": digest(raw),
        "controlRef": args.control_ref, "controlSourceSha256": digest(old),
        "implementationHashes": {name: digest((ROOT / name).read_bytes())
            for name in ("codecs/codec_bridge.py", "codecs/work_control.py", "backend/jobs.py")},
        "python": platform.python_version(), "platform": platform.platform(), "rows": rows,
        "limitations": ["Same canonical document, before JS export normalization; excludes transport, parsing and UI.",
            "Only the historical validation function is extracted; codec globals/constants use the current runtime.",
            "Same-process counterbalanced order, active cancellation context in both variants, GC outside measurements.",
            "No debugger; OS caches and other workstation activity are uncontrolled."]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
