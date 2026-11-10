"""Každá chybová hláška, kterou server posílá do rozhraní, má anglické znění (pult/messages.py)."""
import glob
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pult"))
import messages  # noqa: E402

PATTERN = re.compile(r'(?:"error": |raise ValueError\(|error=)"([^"]+)"')
ENGLISH = re.compile(r"^[A-Z][a-z]+( [a-z]+)+")  # už anglicky (Access code required. …)


class Messages(unittest.TestCase):
    def test_every_error_has_english(self):
        missing = []
        for f in glob.glob(os.path.join(ROOT, "pult", "*.py")):
            with open(f, encoding="utf-8") as fh:
                for msg in PATTERN.findall(fh.read()):
                    sample = msg.replace("%s", "x").replace("%d", "1")
                    if not ENGLISH.match(msg) and messages.en(sample) == sample:
                        missing.append("%s: %s" % (os.path.basename(f), msg))
        self.assertEqual(missing, [])

    def test_regex_messages(self):
        self.assertEqual(messages.en("Soubor nenalezen: /a.mp4"), "File not found: /a.mp4")
        self.assertEqual(messages.en("something else"), "something else")


if __name__ == "__main__":
    unittest.main()
