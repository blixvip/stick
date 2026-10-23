"""Where native libraries are built and found, per platform (no library needed)."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

import server  # noqa: F401  (puts the codec modules on the import path)
import native_scan

ROOT = Path("/repo")


class BuildDirectoryTests(unittest.TestCase):
    def test_windows_keeps_the_historical_tracked_directory(self):
        self.assertEqual(native_scan.build_directory(ROOT, "win32", "x64"), ROOT / "native" / "bin" / "x64")
        self.assertEqual(native_scan.build_directory(ROOT, "win32", "x86"), ROOT / "native" / "bin" / "x86")

    def test_other_platforms_never_share_a_directory_with_windows(self):
        windows = native_scan.build_directory(ROOT, "win32", "x64")
        linux = native_scan.build_directory(ROOT, "linux", "x64")
        macos = native_scan.build_directory(ROOT, "darwin", "arm64")
        self.assertEqual(linux, ROOT / "native" / "bin" / "linux-x64")
        self.assertEqual(macos, ROOT / "native" / "bin" / "darwin-arm64")
        self.assertEqual(len({windows, linux, macos}), 3)

    def test_library_names_follow_the_platform(self):
        self.assertEqual(native_scan.library_name("win32"), "styk-piv-frame-scan.dll")
        self.assertEqual(native_scan.library_name("linux"), "libstyk-piv-frame-scan.so")
        self.assertEqual(native_scan.library_name("darwin"), "libstyk-piv-frame-scan.dylib")

    def test_defaults_describe_this_host(self):
        self.assertEqual(native_scan.library_name(), native_scan.library_name(sys.platform))
        self.assertTrue(str(native_scan.build_directory()).startswith(str(native_scan.ROOT / "native" / "bin")))


if __name__ == "__main__":
    unittest.main()
