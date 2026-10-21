import importlib.util
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image


SCRIPT = Path(__file__).resolve().parents[1] / "tools/upscaling/gemini/evaluate.py"
SPEC = importlib.util.spec_from_file_location("gemini_evaluate", SCRIPT)
EVALUATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVALUATOR)
REGIONS = [{"id": "fixture", "label": "Fixture <shape>", "box": [0.1, 0.1, 0.4, 0.4]}]
JUDGE = SCRIPT.with_name("judge.mjs")


def judge_result(source, candidate):
    return {"schemaVersion": 2, "evaluationVersion": "objects-v2", "status": "succeeded",
            "model": "judge-model", "inputs": [
                {"role": "source", "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
                {"role": "candidate", "sha256": hashlib.sha256(candidate.read_bytes()).hexdigest()}],
            "judgment": {"global": {"addedObjects": [], "removedObjects": [],
                                      "composition": {"status": "preserved", "evidence": "Same layout"}},
                         "objects": [{"id": "fixture", "presence": "preserved", "silhouette": "changed",
                                      "internalGeometry": "preserved", "count": "preserved",
                                      "evidence": "Added <fixture> curve"}], "uncertainties": []},
            "decision": {"verdict": "reject", "reasons": ["Shape changed"], "automaticApproval": False}}


class EvaluationTests(unittest.TestCase):
    def pilot_fixture(self, root):
        source, candidate = root / "source.png", root / "candidate.png"
        Image.new("RGB", (20, 15), "white").save(source)
        Image.new("RGB", (80, 40), "gray").save(candidate)
        folder = root / "jobs" / "pilot"
        folder.mkdir(parents=True)
        (folder / "result.json").write_text(json.dumps({"status": "succeeded", "images": [{"path": str(candidate)}]}))
        plan = {"schemaVersion": 1, "project": "test-project", "regionProfiles": {"rooms": {"new-room": REGIONS}},
                "rooms": [{"id": "new-room", "sourcePath": str(source),
                           "provenance": {"verified": True}, "inventory": ["fixture"]}],
                "controls": [{"id": "Scene1001", "roomId": "Scene1001", "sourcePath": str(source),
                              "path": str(candidate), "label": "Historical control"}],
                "jobs": [{"id": "pilot", "roomId": "new-room"}]}
        (root / "experiment.json").write_text(json.dumps(plan))
        return source, candidate, folder, plan

    def test_frozen_profiles_and_private_single_page(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, candidate, folder, plan = self.pilot_fixture(root)
            (root / "visual-review.json").write_text(json.dumps({"schemaVersion": 1, "rooms": {
                "new-room": {"texture": "Subjectively too smooth <not structure>"}}}))
            (root / "pilot-summary.json").write_text(json.dumps({"succeeded": 1}))
            with patch.object(EVALUATOR, "load_profiles", side_effect=AssertionError("must use frozen profiles")):
                first = EVALUATOR.evaluate(root)
            entry = first["rooms"][0]["entries"][-1]
            self.assertEqual(entry["decision"]["verdict"], "blocked")
            judge = judge_result(source, candidate)
            judge["profileFingerprint"] = EVALUATOR.profile_fingerprint(REGIONS)
            for region in entry["objectRegions"]:
                for role in ("source", "candidate"):
                    judge["inputs"].append({"role": f"{role}-crop:{region['id']}",
                                            "sha256": hashlib.sha256(Path(region[role + "Path"]).read_bytes()).hexdigest()})
            judge_path = folder / "judge-objects-v2.json"
            judge_path.write_text(json.dumps(judge))
            result = EVALUATOR.evaluate(root)
            self.assertEqual(result["rooms"][0]["entries"][-1]["decision"]["verdict"], "reject")
            self.assertEqual(result["rooms"][0]["provenance"], {"verified": True})
            self.assertTrue(all(e["kind"] != "candidate" for e in result["rooms"][1]["entries"]))
            report = (root / "report.html").read_text()
            for text in ("Original native dimensions: 20x15", "native 80x40", "Side by side", "A: original",
                         "B: result", "Subjective Appearance Notes", "Subjectively too smooth &lt;not structure&gt;",
                         "Aggregate Pilot Summary", "Source Provenance", "Historical control"):
                self.assertIn(text, report)
            self.assertIn("height:auto", report)
            self.assertEqual((root / "report.html").stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / "eval-assets").stat().st_mode & 0o777, 0o700)
            judge["inputs"][-1]["sha256"] = "stale-crop"
            judge_path.write_text(json.dumps(judge))
            stale_crop = EVALUATOR.evaluate(root)["rooms"][0]["entries"][-1]
            self.assertEqual(stale_crop["decision"]["verdict"], "blocked")
            self.assertIn("crop hashes", stale_crop["decision"]["reasons"][0])
            # Same IDs and full-frame bytes cannot authorize changed ROIs.
            plan["regionProfiles"]["rooms"]["new-room"] = [{**REGIONS[0], "box": [0.2, 0.1, 0.5, 0.4]}]
            (root / "experiment.json").write_text(json.dumps(plan))
            result = EVALUATOR.evaluate(root)
            self.assertIn("profile fingerprint", result["rooms"][0]["entries"][-1]["decision"]["reasons"][0])
            # Frozen profiles never fall back to the global file if malformed.
            plan["regionProfiles"]["rooms"]["new-room"] = []
            (root / "experiment.json").write_text(json.dumps(plan))
            with patch.object(EVALUATOR, "load_profiles", side_effect=AssertionError("no fallback")):
                result = EVALUATOR.evaluate(root)
            self.assertEqual(result["rooms"][0]["entries"][-1]["decision"]["verdict"], "blocked")

    def test_ten_room_pilot_report_preserves_manifest_order_and_native_sizes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _, folder, plan = self.pilot_fixture(root)
            plan["controls"] = []
            plan["rooms"], plan["jobs"], plan["regionProfiles"]["rooms"] = [], [], {}
            for index in range(10):
                identifier = f"opaque-{index}"
                image = root / f"{identifier}.png"
                Image.new("RGB", (40 + index, 30), "white").save(image)
                job = root / "jobs" / identifier
                job.mkdir()
                (job / "result.json").write_text(json.dumps({"status": "succeeded", "images": [{"path": str(image)}]}))
                plan["rooms"].append({"id": identifier, "sourcePath": str(source)})
                plan["jobs"].append({"id": identifier, "roomId": identifier})
                plan["regionProfiles"]["rooms"][identifier] = REGIONS
            (root / "experiment.json").write_text(json.dumps(plan))
            result = EVALUATOR.evaluate(root)
            self.assertEqual([r["id"] for r in result["rooms"]], [f"opaque-{i}" for i in range(10)])
            report = (root / "report.html").read_text()
            self.assertEqual(report.count("Blind judge decision: blocked"), 10)
            for index, room in enumerate(result["rooms"]):
                entry = room["entries"][-1]
                self.assertEqual(entry["nativeDimensions"], [40 + index, 30])
                self.assertIn(f"native {40 + index}x30", report)
                self.assertEqual(len(entry["objectRegions"]), 1)

    def test_frozen_judge_requires_crop_hashes_and_blocks_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, candidate, folder, _ = self.pilot_fixture(root)
            judge = judge_result(source, candidate)
            judge["profileFingerprint"] = EVALUATOR.profile_fingerprint(REGIONS)
            path = folder / "judge-objects-v2.json"
            for status in ("succeeded", "failed-or-outcome-unknown-no-auto-retry", "in-flight-outcome-unknown"):
                judge["status"] = status
                path.write_text(json.dumps(judge))
                result = EVALUATOR.evaluate(root)
                self.assertEqual(result["rooms"][0]["entries"][-1]["decision"]["verdict"], "blocked")

    def test_node_profile_validation_and_exclusive_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            script = """
                import assert from 'node:assert/strict';
                import {readFile, stat} from 'node:fs/promises';
                const {validateProfiles, profileFingerprint, claimJudgment} = await import(process.argv[1]);
                const regions = JSON.parse(process.argv[2]);
                assert.deepEqual(validateProfiles({schemaVersion:1,rooms:{new:regions}}), {new:regions});
                for (const bad of [[], [...regions,...regions], [{...regions[0],box:[0,0,2,1]}],
                    [{...regions[0],box:[0,0,true,1]}]]) {
                    assert.throws(() => validateProfiles({schemaVersion:1,rooms:{new:bad}}));
                }
                assert.equal(profileFingerprint(regions), process.argv[3]);
                const claims = await Promise.all(Array.from({length:8}, () => claimJudgment(process.argv[4], {status:'in-flight-outcome-unknown'})));
                assert.equal(claims.filter(Boolean).length, 1);
                assert.equal(JSON.parse(await readFile(process.argv[4], 'utf8')).status, 'in-flight-outcome-unknown');
                assert.equal((await stat(process.argv[4])).mode & 0o777, 0o600);
            """
            subprocess.run(["node", "--input-type=module", "-e", script, JUDGE.as_uri(),
                            json.dumps(REGIONS), EVALUATOR.profile_fingerprint(REGIONS),
                            str(Path(directory) / "judge.json")], check=True, capture_output=True)

    def test_node_judge_usage_failure_no_retry_and_stale_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, candidate, folder, plan = self.pilot_fixture(root)
            EVALUATOR.evaluate(root)
            # An isolated token helper and mocked fetch ensure no cloud requests.
            token = root / "gcloud"
            token.write_text("#!/bin/sh\nprintf test-token")
            token.chmod(0o700)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            script = """
                const [module, directory] = process.argv.slice(1);
                globalThis.fetch = async () => ({ok:true,status:200,json:async () => ({
                    responseId:'response-test',modelVersion:'model-test',usageMetadata:{totalTokenCount:27},
                    candidates:[{finishReason:'STOP',content:{parts:[{text:'invalid json'}]}}]
                })});
                process.argv = [process.execPath, new URL(module).pathname, directory, '--execute'];
                await import(module);
            """
            command = ["node", "--input-type=module", "-e", script, JUDGE.as_uri(), str(root)]
            first = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(first.returncode, 1, first.stderr)
            usage = json.loads((folder / "judge-objects-v2-usage.json").read_text())
            self.assertEqual(usage["responseId"], "response-test")
            self.assertEqual(usage["modelVersion"], "model-test")
            self.assertEqual(usage["finishReasons"], ["STOP"])
            self.assertEqual(usage["usageMetadata"]["totalTokenCount"], 27)
            self.assertTrue(usage["requestStartedAt"] <= usage["finishedAt"])
            before = (folder / "judge-objects-v2.json").read_bytes()
            second = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(second.returncode, 1)
            self.assertIn("skip-existing", second.stdout)
            self.assertEqual((folder / "judge-objects-v2.json").read_bytes(), before)
            plan["regionProfiles"]["rooms"]["new-room"] = [{**REGIONS[0], "box": [0, 0, 0.5, 0.5]}]
            (root / "experiment.json").write_text(json.dumps(plan))
            stale = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(stale.returncode, 1)
            self.assertIn("stale object crops", stale.stderr)

    def test_metrics(self):
        source = Image.new("RGB", (16, 12), (30, 60, 90))
        for candidate in (source, source.resize((64, 48), Image.Resampling.LANCZOS)):
            metrics = EVALUATOR.metrics(source, candidate)
            for key in ("rgbMAE", "rgbRMSE", "lowpassMAE", "aspectRatioRelativeError"):
                self.assertEqual(metrics[key], 0)
            self.assertEqual(metrics["meanDriftRGB"], [0, 0, 0])
            self.assertEqual(metrics["edgeGradientCosine"], 1)
        metrics = EVALUATOR.metrics(source, Image.new("RGB", (32, 12), (40, 80, 120)))
        self.assertEqual(metrics["rgbMAE"], 20)
        self.assertAlmostEqual(metrics["rgbRMSE"], (1400 / 3) ** 0.5)
        self.assertEqual(metrics["lowpassMAE"], 20)
        self.assertEqual(metrics["meanDriftRGB"], [10, 20, 30])
        self.assertEqual(metrics["nativeDimensions"], [32, 12])
        self.assertEqual((metrics["scaleX"], metrics["scaleY"]), (2, 1))
        self.assertEqual(metrics["aspectRatioRelativeError"], 1)

    def test_gradient_cosine(self):
        ramp = np.broadcast_to(np.arange(16, dtype=np.uint8)[None, :, None], (12, 16, 3)).copy()
        source = Image.fromarray(ramp)
        self.assertAlmostEqual(EVALUATOR.metrics(source, source)["edgeGradientCosine"], 1)
        self.assertAlmostEqual(EVALUATOR.metrics(source, Image.fromarray(255 - ramp))["edgeGradientCosine"], -1)
        self.assertEqual(EVALUATOR.metrics(source, Image.new("RGB", source.size))["edgeGradientCosine"], 0)

    def test_lanczos_reduction(self):
        pixels = np.random.default_rng(7).integers(0, 256, (48, 64, 3), dtype=np.uint8)
        candidate = Image.fromarray(pixels)
        source = candidate.resize((16, 12), Image.Resampling.LANCZOS)
        metrics = EVALUATOR.metrics(source, candidate)
        self.assertEqual(metrics["rgbMAE"], 0)
        self.assertEqual(metrics["rgbRMSE"], 0)
        self.assertEqual(metrics["lowpassMAE"], 0)
        self.assertAlmostEqual(metrics["edgeGradientCosine"], 1)

    def test_missing_baseline_and_tiny_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (1, 1), "white").save(root / "source.png")
            (root / "experiment.json").write_text(json.dumps({
                "schemaVersion": 1, "rooms": [{"id": "tiny", "sourcePath": "source.png",
                                               "baselinePath": "absent.png"}], "jobs": []}))
            result = EVALUATOR.evaluate(root)
            entries = result["rooms"][0]["entries"]
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[1]["metrics"]["rgbMAE"], 0)
            self.assertEqual(entries[1]["metrics"]["edgeGradientCosine"], 1)
            subprocess.run([sys.executable, str(SCRIPT), str(root)], check=True, capture_output=True)

    def test_cli_report_and_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_path = root / "source & original.png"
            source = Image.new("RGB", (20, 15), (30, 60, 90))
            source.save(source_path)
            final_path = root / "final ' candidate.png"
            source.resize((80, 60), Image.Resampling.LANCZOS).save(final_path)
            thought_path = root / "thought.png"
            Image.new("RGB", (11, 9), "red").save(thought_path)
            jobs = []
            for job_id in ("good", "failed", "missing", "invalid", "thought-only", "no-image", "bad-shape"):
                jobs.append({"id": job_id, "roomId": "Scene1001", "model": "model<script>",
                             "promptVariant": "variant&1", "referenceMode": "source"})
                folder = root / "jobs" / job_id
                folder.mkdir(parents=True)
                if job_id == "missing":
                    continue
                if job_id == "invalid":
                    (folder / "result.json").write_text("not json")
                    continue
                artifact = {"status": "succeeded", "images": [
                    {"path": str(thought_path), "thought": True},
                    {"path": str(source_path), "thought": False},
                    {"path": str(final_path), "thought": False},
                    {"path": str(thought_path), "thought": True}]}
                if job_id == "failed":
                    artifact["status"] = "failed"
                if job_id == "thought-only":
                    artifact["images"] = [{"path": str(thought_path), "thought": True}]
                if job_id == "no-image":
                    artifact["images"] = [{"path": str(root / "absent.png")}]
                if job_id == "bad-shape":
                    artifact = []
                (folder / "result.json").write_text(json.dumps(artifact))
                if job_id == "good":
                    (folder / "judge-objects-v2.json").write_text(json.dumps(
                        judge_result(source_path, final_path)))
            manifest = {"schemaVersion": 1, "rooms": [
                {"id": "Scene1001", "sourcePath": str(source_path), "baselinePath": str(final_path)},
                {"id": "missing-room", "sourcePath": "absent.png"}], "jobs": jobs}
            (root / "experiment.json").write_text(json.dumps(manifest))
            before = {path: path.read_bytes() for path in (source_path, final_path, thought_path)}
            with patch.object(EVALUATOR, "load_profiles", return_value={"Scene1001": REGIONS}):
                EVALUATOR.evaluate(root)
            result = json.loads((root / "eval.json").read_text())
            room = result["rooms"][0]
            self.assertEqual(room["sourceDimensions"], [20, 15])
            self.assertEqual(len(room["entries"]), 4)
            self.assertEqual(sum(entry["kind"] == "control" for entry in room["entries"]), 2)
            candidate = next(entry for entry in room["entries"] if entry["kind"] == "candidate")
            self.assertEqual(candidate["path"], str(final_path))
            self.assertEqual(candidate["metrics"]["nativeDimensions"], [80, 60])
            self.assertEqual(candidate["metrics"]["rgbMAE"], 0)
            self.assertEqual(candidate["semanticJudge"]["decision"]["verdict"], "reject")
            self.assertEqual(candidate["decision"]["verdict"], "reject")
            self.assertIs(candidate["decision"]["automaticApproval"], False)
            self.assertEqual(result["evaluationPolicy"]["primary"], "object-first")
            self.assertIs(result["evaluationPolicy"]["diagnosticOnlyPixels"], True)
            self.assertEqual(len(result["skipped"]), 7)
            report = (root / "report.html").read_text()
            self.assertNotIn(str(root), report)
            self.assertNotIn("file:", report)
            self.assertNotIn("<script>", report)
            self.assertIn("model&lt;script&gt;", report)
            self.assertIn("source%20%26%20original.png", report)
            self.assertIn("final%20%27%20candidate.png", report)
            self.assertIn("hallucinations", report)
            self.assertIn("Added &lt;fixture&gt;", report)
            self.assertIn("silhouette", report)
            self.assertIn("Blind judge decision: reject", report)
            self.assertIn("Result unavailable: blocked", report)
            self.assertIn("<summary>Diagnostic pixel metrics only", report)
            with Image.open(root / room["contactSheet"]) as sheet:
                self.assertEqual(sheet.size, (1920, 960))
            inputs = json.loads((root / "jobs/good/object-inputs.json").read_text())
            self.assertEqual(inputs["sourceSha256"], hashlib.sha256(source_path.read_bytes()).hexdigest())
            self.assertEqual(inputs["candidateSha256"], candidate["sha256"])
            self.assertEqual(inputs["regions"][0]["id"], "fixture")
            for role in ("source", "candidate"):
                path = Path(inputs["regions"][0][role + "Path"])
                self.assertTrue(path.is_absolute())
                with Image.open(path) as crop:
                    self.assertEqual(crop.size, (24, 20) if role == "source" else (24, 18))
            for path, contents in before.items():
                self.assertEqual(path.read_bytes(), contents)

    def test_v2_validation_is_fail_closed_and_order_is_not_pixel_ranked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            candidate = root / "candidate.png"
            Image.new("RGB", (20, 15), "white").save(source)
            Image.new("RGB", (80, 60), "black").save(candidate)
            valid = judge_result(source, candidate)
            cases = {"reject": valid, "missing": None, "stale-source": copy.deepcopy(valid),
                     "stale-candidate": copy.deepcopy(valid), "old-version": copy.deepcopy(valid),
                     "failed": copy.deepcopy(valid), "duplicate": copy.deepcopy(valid),
                     "missing-object": copy.deepcopy(valid), "extra-object": copy.deepcopy(valid),
                     "uncertain": copy.deepcopy(valid), "preserved": copy.deepcopy(valid),
                     "inconsistent": copy.deepcopy(valid)}
            cases["stale-source"]["inputs"][0]["sha256"] = "stale"
            cases["stale-candidate"]["inputs"][1]["sha256"] = "stale"
            cases["old-version"]["evaluationVersion"] = "objects-v1"
            cases["failed"]["status"] = "failed"
            cases["duplicate"]["judgment"]["objects"] *= 2
            cases["missing-object"]["judgment"]["objects"] = []
            cases["extra-object"]["judgment"]["objects"][0]["id"] = "unconfigured"
            for name in ("uncertain", "preserved", "inconsistent"):
                cases[name]["decision"]["verdict"] = "no-structural-change-detected"
            cases["uncertain"]["judgment"]["objects"][0]["silhouette"] = "uncertain"
            cases["preserved"]["judgment"]["objects"][0]["silhouette"] = "preserved"
            jobs = []
            for name, judge in cases.items():
                folder = root / "jobs" / name
                folder.mkdir(parents=True)
                jobs.append({"id": name, "roomId": "Scene1001"})
                image_path = source if name == "missing" else candidate
                (folder / "result.json").write_text(json.dumps({"status": "succeeded", "images": [
                    {"path": str(image_path)}]}))
                # Legacy judgments must never supply a decision, including when v2 is missing.
                (folder / "judge.json").write_text(json.dumps(valid))
                if judge is not None:
                    (folder / "judge-objects-v2.json").write_text(json.dumps(judge))
            (root / "experiment.json").write_text(json.dumps({"schemaVersion": 1,
                "rooms": [{"id": "Scene1001", "sourcePath": str(source)}], "jobs": jobs}))
            (root / "findings.json").write_text(json.dumps({"shortlist": ["missing"]}))
            with patch.object(EVALUATOR, "load_profiles", return_value={"Scene1001": REGIONS}):
                result = EVALUATOR.evaluate(root)
            entries = [entry for entry in result["rooms"][0]["entries"] if entry["kind"] == "candidate"]
            self.assertEqual([entry["id"] for entry in entries], list(cases))
            for entry in entries:
                expected = {"reject": "reject", "inconsistent": "reject", "uncertain": "review",
                            "preserved": "no-structural-change-detected"}.get(entry["id"], "blocked")
                self.assertEqual(entry["decision"]["verdict"], expected, entry["id"])
                self.assertIs(entry["decision"]["automaticApproval"], False)
                if expected == "blocked":
                    self.assertNotIn("semanticJudge", entry)
                    self.assertEqual(entry["decision"]["status"], "not-evaluated")
            report = (root / "report.html").read_text()
            self.assertIn("Historical findings (superseded", report)
            self.assertNotIn("Pilot Findings And Shortlist", report)
            with patch.object(EVALUATOR, "load_profiles", return_value={}):
                result = EVALUATOR.evaluate(root)
            self.assertTrue(all(entry["decision"]["verdict"] == "blocked"
                                for entry in result["rooms"][0]["entries"] if entry["kind"] == "candidate"))

    def test_native_object_crop_aspect_and_max_edge(self):
        source = Image.new("RGB", (100, 100))
        candidate = Image.new("RGB", (2000, 1000))
        box = [0.1, 0.1, 0.9, 0.9]
        self.assertEqual(EVALUATOR.object_crop(source, box, 768).size, (768, 768))
        self.assertEqual(EVALUATOR.object_crop(candidate, box, 768).size, (768, 384))

    def test_all_structural_changes_override_clear_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.png"
            Image.new("RGB", (20, 15), "white").save(image)
            digest = hashlib.sha256(image.read_bytes()).hexdigest()
            path = root / "judge-objects-v2.json"
            for field in ("presence", "silhouette", "internalGeometry", "count",
                          "composition", "addedObjects", "removedObjects", "uncertainties"):
                with self.subTest(field=field):
                    judge = judge_result(image, image)
                    judge["judgment"]["objects"][0]["silhouette"] = "preserved"
                    judge["decision"]["verdict"] = "no-structural-change-detected"
                    if field in ("addedObjects", "removedObjects"):
                        judge["judgment"]["global"][field] = ["Fixture at ceiling"]
                    elif field == "composition":
                        judge["judgment"]["global"][field]["status"] = "changed"
                    elif field == "uncertainties":
                        judge["judgment"][field] = ["Detail cannot be resolved"]
                    else:
                        judge["judgment"]["objects"][0][field] = "changed"
                    path.write_text(json.dumps(judge))
                    result = EVALUATOR.validated_judge(path, digest, digest, REGIONS)
                    self.assertEqual(result["decision"]["verdict"],
                                     "review" if field == "uncertainties" else "reject")
                    self.assertIs(result["decision"]["automaticApproval"], False)

    def test_profiles_validate_normalized_regions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object-regions.json"
            with patch.object(EVALUATOR, "OBJECT_REGIONS_PATH", path):
                path.write_text(json.dumps({"schemaVersion": 1, "rooms": {"Scene1001": REGIONS}}))
                self.assertEqual(EVALUATOR.load_profiles(), {"Scene1001": REGIONS})
                for regions in (REGIONS * 2, [{**REGIONS[0], "box": [0, 0, 2, 1]}], []):
                    path.write_text(json.dumps({"schemaVersion": 1, "rooms": {"Scene1001": regions}}))
                    with self.assertRaises(ValueError):
                        EVALUATOR.load_profiles()

    def test_relative_uri(self):
        self.assertEqual(EVALUATOR.relative_uri(Path("/tmp/source image.png"), Path("/tmp/run")),
                         "../source%20image.png")


if __name__ == "__main__":
    unittest.main()
