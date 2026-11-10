import os
import struct
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pult"))
import library  # noqa: E402


def atom(kind, payload=b""):
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


class Faststart(unittest.TestCase):
    def check(self, data):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
        self.addCleanup(os.remove, f.name)
        return library.is_faststart(f.name)

    def test_moov_before_mdat(self):
        self.assertTrue(self.check(atom(b"ftyp", b"x" * 8) + atom(b"moov", b"m") + atom(b"mdat", b"d")))

    def test_mdat_before_moov(self):
        self.assertFalse(self.check(atom(b"ftyp") + atom(b"mdat", b"d") + atom(b"moov", b"m")))

    def test_garbage(self):
        self.assertFalse(self.check(b"\x00\x00\x00\x01"))


class Sizes(unittest.TestCase):
    def test_landscape_4k(self):
        self.assertEqual(library.proxy_size(3840, 2160, 1920), (1920, 1080))

    def test_never_upscales_and_stays_even(self):
        self.assertEqual(library.proxy_size(1279, 719, 1920), (1280, 720))


class Priority(unittest.TestCase):
    @mock.patch.object(library.config, "IS_MAC", True)
    @mock.patch.object(library.os.path, "exists", return_value=True)
    def test_mac_uses_qos(self, _):
        self.assertEqual(library.low_priority(["ffmpeg"])[:3], ["/usr/sbin/taskpolicy", "-c", "utility"])


if __name__ == "__main__":
    unittest.main()
