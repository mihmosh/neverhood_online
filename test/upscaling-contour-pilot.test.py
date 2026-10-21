"""Offline end-to-end checks for immutable image-guided contour reports."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/upscaling/static"))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FIXTURES = load("static_pilot_fixtures", ROOT / "test/upscaling-static-pilot.test.py")
CONTOURS = load("contour_pilot", ROOT / "tools/upscaling/static/contour_pilot.py")


class ContourPilotTests(unittest.TestCase):
    def test_frozen_context_report_and_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared, catalog, baseline_output, nano_result = FIXTURES.PilotTests().fixture(root)
            FIXTURES.PILOT.run(prepared, catalog, baseline_output, nano_result)
            output = root / "guided"
            record = CONTOURS.run(baseline_output / "manifest.json", output)
            self.assertEqual(len(record["assets"]), 6)
            self.assertEqual(record["inferenceRequests"], 0)
            self.assertFalse(record["runtimePromotion"])
            self.assertEqual(record["policy"], "coarse-source-prior-restored-rgb-boundary")
            for asset in record["assets"]:
                self.assertEqual(asset["result"]["processingMethods"]["alpha"], "image-guided")
                self.assertFalse(asset["result"]["invariants"]["sourceMaskComparisonIsAcceptanceCriterion"])
                self.assertFalse(asset["result"]["diagnostics"]["refinement"]["automaticApproval"])
                for path in [*asset["previews"].values(), *asset["zooms"].values()]:
                    self.assertTrue(Path(path).is_file())
            latest = json.loads((output / "latest.json").read_text())
            manifest_path = Path(latest["manifest"])
            digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            self.assertEqual(CONTOURS.run(baseline_output / "manifest.json", output), record)
            self.assertEqual(hashlib.sha256(manifest_path.read_bytes()).hexdigest(), digest)
            page = Path(latest["report"]).read_text()
            self.assertIn('lang="en"', page)
            self.assertIn("Exact equality to the nearest-neighbor mask is not a success criterion", page)
            self.assertIn("image-rendering:pixelated", page)
            self.assertEqual(page.count('<article id="asset-'), 6)


if __name__ == "__main__":
    unittest.main()
