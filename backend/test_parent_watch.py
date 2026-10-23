"""The codec exits when its parent's pipe closes, however the parent dies."""
from __future__ import annotations

import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest

SERVER = Path(__file__).resolve().with_name("server.py")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def start(*flags: str) -> subprocess.Popen:
    process = subprocess.Popen([sys.executable, str(SERVER), "--port", str(free_port()), *flags],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ready = json.loads(process.stdout.readline())
    assert ready["event"] == "ready", ready
    return process


class ParentWatchTests(unittest.TestCase):
    def test_closing_stdin_stops_the_server_promptly(self):
        process = start("--exit-on-stdin-close")
        try:
            time.sleep(0.3)
            self.assertIsNone(process.poll(), "the server must keep running while its parent holds the pipe")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=10), 0)
        finally:
            if process.poll() is None:
                process.kill()

    def test_data_on_the_pipe_is_ignored(self):
        process = start("--exit-on-stdin-close")
        try:
            process.stdin.write(b"noise\n" * 100)
            process.stdin.flush()
            time.sleep(0.4)
            self.assertIsNone(process.poll())
        finally:
            process.stdin.close()
            process.wait(timeout=10)

    def test_without_the_flag_a_closed_stdin_changes_nothing(self):
        process = start()
        try:
            process.stdin.close()
            time.sleep(0.8)
            self.assertIsNone(process.poll(), "a server started by hand must not depend on stdin")
        finally:
            process.kill()
            process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
