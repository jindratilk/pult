"""Kouřový test: server se spustí na dočasné knihovně, pult add přidá obrázek a ten se připraví."""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def tiny_png(path):
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 4 for _ in range(4))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


class Smoke(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.port = free_port()
        cfg = os.path.join(self.tmp.name, "config.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"library": os.path.join(self.tmp.name, "lib"), "port": self.port}, f)
        self.env = dict(os.environ, PULT_CONFIG=cfg)
        self.server = subprocess.Popen([sys.executable, os.path.join(ROOT, "pult", "server.py")], env=self.env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.server.wait, 10)
        self.addCleanup(self.server.terminate)
        for _ in range(100):
            try:
                urllib.request.urlopen(self.url("/"), timeout=1)
                return
            except OSError:
                time.sleep(0.1)
        self.fail("server did not start")

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def get(self, path):
        return json.loads(urllib.request.urlopen(self.url(path), timeout=5).read())

    def test_add_image_and_prepare(self):
        img = os.path.join(self.tmp.name, "frame.png")
        tiny_png(img)
        r = subprocess.run([sys.executable, os.path.join(ROOT, "pult", "cli.py"), "add", "-t", "Smoke", img],
                           env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        bid = json.loads(r.stdout)["batch"]
        for _ in range(100):
            items = self.get("/api/batch/%s" % bid)["batch"]["items"]
            if items and items[0]["state"] in ("ready", "error"):
                break
            time.sleep(0.1)
        self.assertEqual(items[0]["state"], "ready", items[0].get("error"))
        self.assertIn(bid, [b["id"] for b in self.get("/api/batches")["batches"]])


if __name__ == "__main__":
    unittest.main()
