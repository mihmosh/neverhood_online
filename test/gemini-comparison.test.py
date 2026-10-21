import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "tools/upscaling/gemini/comparison.py"
SPEC = importlib.util.spec_from_file_location("comparison", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ComparisonTests(unittest.TestCase):
    def fixture(self, root):
        image = root / "source.png"
        Image.new("RGB", (16, 12), "pink").save(image)
        digest = hashlib.sha256(image.read_bytes()).hexdigest()
        base = {"path": str(image), "sha256": digest}
        evaluation = {"evaluationPolicy": {"primary": "object-first"}, "rooms": []}
        ranking = {"schemaVersion": 1, "rooms": []}
        profiles = {"schemaVersion": 1, "rooms": {}}
        for room_id in ("Scene1001", "Scene1002"):
            profiles["rooms"][room_id] = [{"id": "detail", "label": "Detail", "box": [0, 0, .5, .5]}]
            entries = [{**base, "kind": "source"}, {**base, "kind": "control", "control": "Existing Gemini baseline"}]
            choices = []
            for number in range(3):
                identifier = f"{room_id}-{number}"
                entries.append({**base, "kind": "candidate", "id": identifier,
                                "model": "gemini-nano-banana-2.1", "promptVariant": "preservation",
                                "referenceMode": "none", "decision": {"verdict": "no-structural-change-detected"}})
                choices.append({"id": identifier, "title": "</script><script>bad</script>", "reason": "Review", "tradeoff": "Soft"})
            evaluation["rooms"].append({"id": room_id, "entries": entries})
            ranking["rooms"].append({"id": room_id, "title": "Room", "verdict": "Subjective", "ranking": choices})
        (root / "eval.json").write_text(json.dumps(evaluation))
        (root / "ranking.json").write_text(json.dumps(ranking))
        (root / "profiles.json").write_text(json.dumps(profiles))
        return evaluation

    def test_build_is_local_escaped_and_reproducible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            with patch.object(MODULE, "PROFILES", root / "profiles.json"):
                payload = MODULE.build(root / "ranking.json", root / "output", [root])
            self.assertEqual(payload["ranked"], 6)
            page = (root / "output/index.html").read_text()
            self.assertNotIn("__COMPARISON_DATA__", page)
            self.assertNotIn("</script><script>bad", page)
            self.assertNotIn(str(root), page)
            self.assertEqual(len(payload["rooms"]), 2)
            for room in payload["rooms"]:
                for item in room["items"]:
                    for uri in [item["src"], item["preview"], *item["crops"].values()]:
                        self.assertTrue((root / "output" / uri).is_file())
                        self.assertTrue(uri.startswith("assets/"))

    def test_rejected_or_stale_candidate_cannot_enter_ranking(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evaluation = self.fixture(root)
            for verdict in ("reject", "review", "blocked"):
                evaluation["rooms"][0]["entries"][2]["decision"]["verdict"] = verdict
                (root / "eval.json").write_text(json.dumps(evaluation))
                with patch.object(MODULE, "PROFILES", root / "profiles.json"):
                    with self.assertRaisesRegex(ValueError, "Cannot rank"):
                        MODULE.build(root / "ranking.json", root / "output", [root])
            evaluation["rooms"][0]["entries"][2]["decision"]["verdict"] = "no-structural-change-detected"
            evaluation["rooms"][0]["entries"][2]["sha256"] = "stale"
            (root / "eval.json").write_text(json.dumps(evaluation))
            with patch.object(MODULE, "PROFILES", root / "profiles.json"):
                with self.assertRaisesRegex(ValueError, "Stale image"):
                    MODULE.build(root / "ranking.json", root / "output", [root])


if __name__ == "__main__":
    unittest.main()
