"""Content-free process memory sample for local diagnostics."""
import os
import sys


def memory_mib():
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
                    (name, ctypes.c_size_t) for name in
                    ("peak", "working", "paged_peak", "paged", "nonpaged_peak", "nonpaged", "pagefile", "pagefile_peak")]

            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return counters.working / 1048576
        elif sys.platform.startswith("linux"):
            with open("/proc/self/statm", encoding="ascii") as stream:
                return int(stream.read(256).split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576
        # Unsupported is missing, never zero or a mislabeled lifetime maximum.
    except (OSError, ValueError, IndexError, AttributeError):
        pass
    return None
