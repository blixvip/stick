"""Measure STK fitting for valid parent-first and reverse-record chains.

Run from the repository root with Python 3.12.9:
    python scripts/benchmark-codec-topology-sweep.py --sizes 1000 3000 6000 --pairs 2 --out artifacts/performance-sweep/stk-topology.json

With --control-ref 35ebad9b, compare current production against the frozen
stk_document function extracted from that Git revision. Both use the current
parser/globals. Without it, retain the original iterative-traversal prototype
audit. No production module is changed, and no project is read or written.
"""
from __future__ import annotations

import argparse
import ast
import copy
import gc
import hashlib
import json
import math
from pathlib import Path
import platform
import struct
import subprocess
import sys
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
import server
from profile_import import memory_snapshot


def topology_points(figure):
    """Compute each valid joint once without changing native record order."""
    by_id = {segment["segment_id"]: segment for segment in figure["segments"]}
    if len(by_id) != len(figure["segments"]) or 0 in by_id:
        raise server.piv_codec.PivError("STK contains duplicate/zero segment IDs")
    points = {0: (0.0, 0.0)}
    for segment in figure["segments"]:
        cursor, chain, visiting = segment["segment_id"], [], set()
        while cursor not in points:
            if cursor in visiting or cursor not in by_id:
                raise server.piv_codec.PivError("STK contains missing parents or a cyclic topology")
            visiting.add(cursor)
            item = by_id[cursor]
            chain.append(item)
            cursor = item["parent_id"]
        for item in reversed(chain):
            x, y = points[item["parent_id"]]
            a, length, bend = item["angle_rad"], item["length"], item.get("bend_rad", 0)
            if abs(bend) < 1e-8:
                dx, dy = length * math.cos(a), length * math.sin(a)
            else:
                dx = length / bend * (math.sin(a + bend) - math.sin(a))
                dy = length / bend * (math.cos(a) - math.cos(a + bend))
            points[item["segment_id"]] = (x + dx, y + dy)
    return points


def isolated_importer(source_text, name, *, prototype=False):
    """Extract functions only; never execute a historical module's top level."""
    definitions = {node.name: node for node in ast.parse(source_text).body
        if isinstance(node, ast.FunctionDef)}
    function = copy.deepcopy(definitions["stk_document"])
    start = next(i for i, node in enumerate(function.body)
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "points"
            for target in node.targets))
    end = next(i for i in range(start + 1, len(function.body))
        if isinstance(function.body[i], ast.Assign) and any(isinstance(target, ast.Tuple)
            and any(isinstance(element, ast.Name) and element.id == "x_values" for element in target.elts)
            for target in function.body[i].targets))
    fitting = copy.deepcopy(function.body[start:end])
    loop_function = ast.FunctionDef(name=name + "_points",
        args=ast.arguments(posonlyargs=[], args=[ast.arg(arg="figure")], vararg=None,
            kwonlyargs=[], kw_defaults=[], kwarg=None, defaults=[]),
        body=[*fitting, ast.Return(value=ast.Name(id="points", ctx=ast.Load()))],
        decorator_list=[])
    function.name = name
    if prototype:
        function.body[start:end] = ast.parse("points = topology_points(figure)").body
        loop_function.body = ast.parse("return topology_points(figure)").body
    # Current code places fitting in this helper. A control that also has it
    # needs its historical helper; the earlier inline loop needs no helper.
    helpers = [copy.deepcopy(definitions["_stk_joint_points"])] if "_stk_joint_points" in definitions else []
    module = ast.fix_missing_locations(ast.Module(body=[*helpers, function, loop_function], type_ignores=[]))
    namespace = {**vars(server.bridge), "topology_points": topology_points}
    exec(compile(module, "benchmark_stk_topology_" + name, "exec"), namespace)
    return namespace[function.name], namespace[loop_function.name]


def observed_points(resolve, figure):
    """Count actual parent-field accesses outside every timed import."""
    reads = 0
    class ObservedSegment(dict):
        def __getitem__(self, key):
            nonlocal reads
            if key == "parent_id":
                reads += 1
            return super().__getitem__(key)
    observed = {**figure, "segments": [ObservedSegment(segment) for segment in figure["segments"]]}
    points = resolve(observed)
    return points, reads


def synthetic_stk(count, reverse):
    """Use explicit IDs; the current grammar accepts parents after children."""
    records = list(range(1, count + 1))
    if reverse:
        records.reverse()
    # Line primitives, ordinary paint, implicit z-order, explicit segment IDs,
    # and absent secondary paint. STK omits the PIV-only length-prefixed name.
    flags = 1 | 2 | 4 | 8 | 16 | 128
    payload = bytearray(struct.pack("<BH", flags, count))
    for sid in records:
        payload.extend(struct.pack("<HHfdf", sid - 1, sid, 1 + (sid % 7) * .125,
            (sid % 11 - 5) * .07, 4.0))
    bends = [(index, .06 if sid % 10 else -.035)
        for index, sid in enumerate(records) if sid % 5 == 0]
    payload.extend(struct.pack("<H", len(bends)))
    for index, bend in bends:
        payload.extend(struct.pack("<Hd", index, bend))
    payload.extend(struct.pack("<H", 0))  # No polygons or media.
    return b"\x79" + zlib.compress(payload)


def measure(function, filename, source):
    gc.collect()
    before = memory_snapshot()
    start, cpu = time.perf_counter(), time.process_time()
    document = function(filename, source)
    elapsed = (time.perf_counter() - start) * 1000
    cpu_ms = (time.process_time() - cpu) * 1000
    return document, {"wallMs": elapsed, "cpuMs": cpu_ms,
        "memoryBefore": before, "memoryAfter": memory_snapshot()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", nargs="+", type=int, default=[1000, 3000, 6000])
    parser.add_argument("--pairs", type=int, default=2)
    parser.add_argument("--control-ref", help="Git revision providing the frozen STK importer, e.g. 35ebad9b")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if any(not 1 <= count <= server.piv_codec.MAX_SEGMENTS for count in args.sizes):
        parser.error("Sizes must stay within the production segment limit")
    if not 1 <= args.pairs <= 10:
        parser.error("Pairs must be between 1 and 10")
    sha = lambda value: hashlib.sha256(value).hexdigest()
    current_text = (ROOT / "codecs/codec_bridge.py").read_text(encoding="utf-8")
    _, production_points = isolated_importer(current_text, "current_stk_document")
    control = None
    if args.control_ref:
        if args.control_ref.startswith("-"):
            parser.error("Control refs cannot begin with a dash")
        control_bytes = subprocess.check_output(["git", "show", args.control_ref + ":codecs/codec_bridge.py"], cwd=ROOT)
        control_import, control_points = isolated_importer(control_bytes.decode("utf-8"), "control_stk_document")
        control = {"ref": args.control_ref, "sourcePath": "codecs/codec_bridge.py",
            "sourceSha256": sha(control_bytes), "function": "stk_document"}
        imports = {"control": control_import, "production": server.bridge.stk_document}
        resolvers = {"control": control_points, "production": production_points}
    else:
        candidate, candidate_points = isolated_importer(current_text, "candidate_stk_document", prototype=True)
        imports = {"production": server.bridge.stk_document, "candidate": candidate}
        resolvers = {"production": production_points, "candidate": candidate_points}
    rows, fixtures = [], []
    source_files = ["codecs/codec_bridge.py", "codecs/piv_codec.py", "backend/server.py",
        "scripts/benchmark-codec-topology-sweep.py"]
    hashes = {name: sha((ROOT / name).read_bytes()) for name in source_files}
    for count in args.sizes:
        for reverse in [False, True]:
            shape = "reverse-parent-order" if reverse else "parent-first"
            source = synthetic_stk(count, reverse)
            filename = Path("synthetic-stk-topology.stk")
            fixtures.append({"segments": count, "shape": shape, "bytes": len(source),
                "sha256": sha(source)})
            reference = server.bridge.stk_document(filename, source)
            server.bridge.validate_document(reference)
            figure = reference["figure_types"][1]
            assert [item["segment_id"] for item in figure["segments"]] == (list(range(count, 0, -1)) if reverse else list(range(1, count + 1)))
            expected_points = production_points(figure)
            assert len(expected_points) == count + 1
            parent_reads = {}
            for mode, resolve in resolvers.items():
                points, parent_reads[mode] = observed_points(resolve, figure)
                assert points == expected_points, "Exact joint points differ"
                del points
            for pair in range(args.pairs):
                modes = list(imports) if pair % 2 == 0 else list(reversed(imports))
                for mode in modes:
                    document, timings = measure(imports[mode], filename, source)
                    server.bridge.validate_document(document)  # Outside the timed import.
                    assert document == reference, "Complete imported reports differ"
                    row = {"segments": count, "shape": shape, "pair": pair, "mode": mode,
                        "parentFieldReads": parent_reads[mode],
                        "visitScope": "Actual parent_id accesses in a separate untimed fitting run; excludes grammar and timed importer instrumentation",
                        "fullDocumentParity": True, **timings}
                    rows.append(row)
                    print(json.dumps({key: row[key] for key in ["segments", "shape", "pair", "mode", "wallMs", "parentFieldReads"]}), flush=True)
                    del document
            del figure, reference, expected_points
    assert hashes == {name: sha((ROOT / name).read_bytes()) for name in source_files}, "Source drift during benchmark"
    report = {"measuredAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": platform.python_version(), "platform": platform.platform(),
        "comparison": "production-vs-frozen-control" if control else "production-vs-audit-prototype",
        "control": control,
        "conditions": {"production": "Current live stk_document, unchanged by this benchmark",
            **({"control": "Frozen stk_document and fitting helper (if present); current grammar/globals"} if control else
                {"candidate": "AST-isolated current importer with benchmark-only iterative fitting"})},
        "hashes": hashes, "fixtures": fixtures, "rows": rows,
        "correctness": ["Real modern compressed STK inputs accepted by production grammar",
            "Every full imported report matches current production exactly in both conditions",
            "Every native joint point matches current production exactly in both conditions",
            "All reports pass existing document validation; original native record order is preserved"],
        "limitations": ["Synthetic long chains characterize scaling; they do not represent typical user STKs",
            "Wall time covers in-process decoding and STK fitting, not HTTP, browser transfer, editor setup or rendering",
            "Counterbalanced modes share one process; GC is outside timing, allocator/OS caches are not isolated",
            "Each condition retains the same full reference document and point table; correctness/counting preparation precedes timing",
            "RSS/working-set peaks are process lifetime high-water values, not per-variant allocation peaks",
            "Parent-field accesses are counted in separate untimed fitting calls; timed imports have no counting instrumentation",
            "Historical control uses current parser/globals; this isolates importer/fitting changes, not the complete historical application",
            "Synthetic parity checks do not certify malformed-input, cancellation or full-corpus behavior"]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
