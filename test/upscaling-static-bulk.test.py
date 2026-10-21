"""Exercise the local static ledger without private game files or network calls."""

from copy import deepcopy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

DIRECTORY = Path(__file__).resolve().parents[1] / "tools/upscaling/static"
sys.path.insert(0, str(DIRECTORY))


def module(name):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bulk = module("bulk")
        self.pipeline = module("pipeline")
        yy, xx = np.indices((16, 16))
        mask = (xx - 8) ** 2 + (yy - 8) ** 2 < 5 ** 2
        rgba = np.zeros((16, 16, 4), np.uint8)
        rgba[:, :, :3] = [190, 110, 70]
        rgba[:, :, 3] = mask * 255
        self.source = self.root / "source.png"
        Image.fromarray(rgba).save(self.source)
        hy, hx = np.indices((64, 64))
        truth = (hx - 33) ** 2 + (hy - 32) ** 2 < 20 ** 2
        rgb = np.where(truth[:, :, None], [190, 110, 70], [30, 70, 140]).astype(np.uint8)
        self.rgb = self.root / "restored.png"
        Image.fromarray(rgb).save(self.rgb)
        asset = {"id": "fixture-circle", "kind": "static-prop", "sourcePath": str(self.source),
                 "sourceSHA256": self.bulk.sha(self.source), "contentSize": [16, 16], "canvasSize": [16, 16],
                 "placement": [0, 0], "sourceIdentity": {"sourceBinding": "fixture", "runtimeKey": "fixture-key", "state": "visible"}}
        self.selection = {"schemaVersion": 1, "signature": {"version": 1, "bandNative": 3},
                          "bindings": [{"id": "visible", "scene": "SceneFixture", "resource": "00000001", "kind": "static-prop", "asset": asset,
                                        "processingStatus": "eligible", "blockedReasons": [], "stateRules": {"visible": True}},
                                       {"id": "pressed", "scene": "SceneFixture", "resource": "00000002", "kind": "static-prop",
                                        "processingStatus": "blocked", "blockedReasons": ["missing-restored-state-RGB"], "stateRules": {"visibleTicks": 8}}],
                          "sourceUses": [{"id": "call1"}, {"id": "call2"}], "sourceInventory": {"uses": [{"id": "call1"}, {"id": "call2"}]},
                          "sourceCoverage": {"candidateSites": 2}, "preparedBindings": 2, "scopeLimits": ["Synthetic fixture, no gameplay approval"]}
        self.output = self.root / "output"
        self.calls = 0

    def tearDown(self):
        self.temp.cleanup()

    def process(self, item, run_dir, band):
        self.calls += 1
        asset = deepcopy(item["asset"])
        asset["sourceIdentity"]["bulkBindingId"] = item["id"]
        return self.pipeline.process_asset(asset, run_dir / "candidates", rgb_path=self.rgb, band_native=band)

    def test_index_prepare_execute_and_verified_resume(self):
        before = self.bulk.execute_selection(self.selection, self.output, processor=self.process)
        self.assertEqual(before["processingCounts"], {"blocked": 1, "pending": 1})
        self.assertEqual(self.calls, 0)
        after = self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(after["processingCounts"], {"blocked": 1, "succeeded": 1})
        self.assertEqual(self.calls, 1)
        self.assertFalse(after["wholeGameSemanticClosureProven"])
        self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(self.calls, 1)
        with closing(sqlite3.connect(self.output / "index.sqlite")) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0], 6)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM source_uses").fetchone()[0], 2)
        records = [json.loads(line) for line in Path(after["indexPath"]).read_text().splitlines()]
        pressed = next(record for record in records if record["id"] == "pressed")
        self.assertEqual(pressed["metadata"]["stateRules"]["visibleTicks"], 8)
        self.assertEqual(pressed["blockedReasons"], ["missing-restored-state-RGB"])
        self.assertFalse(pressed["automaticApproval"])

    def test_corrupted_outputs_fail_without_silent_regeneration(self):
        summary = self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        records = [json.loads(line) for line in Path(summary["indexPath"]).read_text().splitlines()]
        path = Path(next(record for record in records if record["id"] == "visible")["result"]["outputs"]["rgba"]["path"])
        path.write_bytes(path.read_bytes() + b"tampering")
        with self.assertRaisesRegex(ValueError, "input or output changed"):
            self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(self.calls, 1)

    def test_failures_require_explicit_retry_and_preserve_attempt_history(self):
        def fail(*args):
            raise RuntimeError("synthetic failure")
        first = self.bulk.execute_selection(self.selection, self.output, execute=True, processor=fail)
        self.assertEqual(first["processingCounts"], {"blocked": 1, "failed": 1})
        self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(self.calls, 0)
        final = self.bulk.execute_selection(self.selection, self.output, execute=True, retry_failed=True, processor=self.process)
        self.assertEqual(final["processingCounts"], {"blocked": 1, "succeeded": 1})
        with closing(sqlite3.connect(self.output / "index.sqlite")) as db, db:
            self.assertEqual([row[0] for row in db.execute("SELECT status FROM attempts ORDER BY id")], ["failed", "succeeded"])

    def test_interrupted_attempt_is_reconciled_under_the_exclusive_lock(self):
        prepared = self.bulk.execute_selection(self.selection, self.output, processor=self.process)
        with closing(sqlite3.connect(self.output / "index.sqlite")) as db, db:
            db.execute("UPDATE bindings SET status='running' WHERE run_id=? AND id='visible'", (prepared["run"],))
            db.execute("INSERT INTO attempts(run_id,binding_id,status,worker_pid) VALUES(?,?,?,?)",
                       (prepared["run"], "visible", "running", 999999))
        result = self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(result["processingCounts"], {"blocked": 1, "succeeded": 1})
        with closing(sqlite3.connect(self.output / "index.sqlite")) as db, db:
            self.assertEqual([row[0] for row in db.execute("SELECT status FROM attempts ORDER BY id")],
                             ["interrupted-before-reconciliation", "succeeded"])

    def test_pressed_state_stays_blocked_even_with_a_base_background(self):
        asset = deepcopy(self.selection["bindings"][1])
        joined = self.bulk.attach_backgrounds([asset], {"rooms": []})
        self.assertEqual(joined[0]["processingStatus"], "blocked")
        self.assertEqual(joined[0]["blockedReasons"], ["missing-restored-state-RGB"])
        self.assertNotIn("backgroundRef", joined[0])

    def test_valid_artifacts_cannot_be_reassigned_to_a_different_binding(self):
        summary = self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        record = next(json.loads(line) for line in Path(summary["indexPath"]).read_text().splitlines()
                      if json.loads(line)["id"] == "visible")
        path = Path(record["resultPath"])
        result = json.loads(path.read_text())
        result.pop("manifestSHA256")
        result["sourceIdentity"]["bulkBindingId"] = "different-binding"
        result["manifestSHA256"] = self.bulk.hashlib.sha256(self.bulk.canonical(result)).hexdigest()
        path.write_bytes(self.bulk.canonical(result))
        with closing(sqlite3.connect(self.output / "index.sqlite")) as db, db:
            db.execute("UPDATE bindings SET result_sha256=? WHERE run_id=? AND id='visible'",
                       (self.bulk.sha(path), summary["run"]))
        with self.assertRaisesRegex(ValueError, "Result binding metadata differs"):
            self.bulk.execute_selection(self.selection, self.output, execute=True, processor=self.process)
        self.assertEqual(self.calls, 1)

    def test_source_evidence_and_implementation_are_snapshotted(self):
        source = self.root / "scummvm/engines/neverhood/example.cpp"
        source.parent.mkdir(parents=True)
        source.write_text("void Example::scene() { insertStaticSprite(0x00000001, 100); }\n")
        self.selection["sourceInventory"]["files"] = [{"path": "scummvm/engines/neverhood/example.cpp", "sha256": self.bulk.sha(source)}]
        self.selection["signature"]["implementationSHA256"] = {"bulk.py": self.bulk.sha(DIRECTORY / "bulk.py")}
        with patch.object(self.bulk, "ROOT", self.root):
            summary = self.bulk.execute_selection(self.selection, self.output, processor=self.process)
            run_dir = Path(summary["reportPath"]).parent
            self.assertEqual((run_dir / "source-evidence/scummvm/engines/neverhood/example.cpp").read_bytes(), source.read_bytes())
            self.assertEqual((run_dir / "implementation/bulk.py").read_bytes(), (DIRECTORY / "bulk.py").read_bytes())
            source.write_text("changed source\n")
            with self.assertRaisesRegex(ValueError, "source evidence changed"):
                self.bulk.execute_selection(self.selection, self.output, processor=self.process)


if __name__ == "__main__":
    unittest.main()
