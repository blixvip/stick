"""Read-only Pivot 5.2.11 joining/soft-selection inspection using parent tools.

Run from the repository root. Does not launch or modify Pivot or user projects.
"""
from pathlib import Path
import hashlib
import sys

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
sys.path.insert(0, str(ROOT / 'tools/research/vendor'))
import capstone
import pefile

binary = ROOT / 'Pivot Animator v5/pivot.exe'
blob = binary.read_bytes()
assert hashlib.sha256(blob).hexdigest() == '2c7911d3303cc28de2ac016c3f7575082aa47680e63a0fe8930ce8799de3df98'
pe = pefile.PE(data=blob, fast_load=True)
base = pe.OPTIONAL_HEADER.ImageBase
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)

checks = [
    (0xb1e0fd, 'cmp', 'bx, 0x4a'),  # J key
    (0xb1e11b, 'call', '0xb24248'),  # shared button action
    (0xb24265, 'cmp', 'word ptr [esi + 0x20], 1'),  # one selected figure
    (0xb242bc, 'cmp', 'byte ptr [eax + 0x42], 0'),  # attachment flag
    (0xb242d5, 'call', '0x949100'),  # detach
    (0xb209ea, 'call', '0x948cb8'),  # mouse-up soft hit
    (0xb20a65, 'call', '0x94c080'),  # repeated click selects joined figures
]
for address, mnemonic, operands in checks:
    instruction = next(md.disasm(pe.get_data(address - base, 16), address))
    assert (instruction.mnemonic, instruction.op_str) == (mnemonic, operands)

ranges = [
    ('J keyboard dispatch', 0xb1e0fd, 0x35),
    ('Join/unjoin button dispatch', 0xb24248, 0x122),
    ('Mouse-up selection', 0xb20998, 0x150),
    ('Soft figure hit', 0x948cb8, 0x79),
    ('Joined selection traversal', 0x94c080, 0x148),
]
out = []
for name, address, size in ranges:
    out.append(f'\n=== {name} {address:#x} ===')
    for instruction in md.disasm(pe.get_data(address - base, size), address):
        out.append(f'{instruction.address:08x}: {instruction.mnemonic:8s} {instruction.op_str}')
output = APP / 'artifacts/native-static/join-selection-disassembly.txt'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text('\n'.join(out), encoding='utf8')
print(f'{len(checks)} native instruction assertions passed; {output}')
