import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw
import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "tools/upscaling/gemini/bulk-check.py"
SPEC = importlib.util.spec_from_file_location("gemini_bulk_check", SCRIPT)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


def save_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def metadata(path, **extra):
    data = path.read_bytes()
    with Image.open(path) as image:
        return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                "dimensions": list(image.size), "mimeType": Image.MIME[image.format], **extra}


class BulkCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name) / "private-assets"
        self.run = self.private / "run"
        self.folder = self.run / "jobs" / "job"
        self.folder.mkdir(parents=True)
        self.private_patch = patch.object(CHECKER, "PRIVATE_ROOT", self.private)
        self.private_patch.start()
        self.addCleanup(self.private_patch.stop)
        source = self.private / "original.png"
        self.source = Image.new("RGB", (640, 480), (40, 70, 90))
        draw = ImageDraw.Draw(self.source)
        draw.rectangle((80, 90, 270, 320), fill=(160, 130, 70))
        draw.ellipse((330, 160, 420, 300), fill=(10, 20, 40))
        self.source.save(source)
        self.output = self.folder / "candidate.png"
        self.source.resize((2400, 1792), Image.Resampling.LANCZOS).save(self.output)
        self.job = {"id": "job", "roomId": "room<1>", "model": CHECKER.MODEL, "requestHash": "hash",
                    "settings": {"responseModalities": ["TEXT", "IMAGE"],
                                 "imageConfig": {"imageSize": "2K", "aspectRatio": "4:3"}},
                    "attachments": [metadata(source, role="source-composition")]}
        self.manifest = {"schemaVersion": 1, "rooms": [{"id": "room<1>", "sourcePath": str(source),
                          "source": metadata(source), "aliases": ["alias<&>"],
                          "provenance": {"archive": "fixture"}}], "jobs": [self.job], "reused": [],
                         "exclusions": [{"roomId": "excluded", "reason": "transparent"}]}
        self.record = {"status": "succeeded", "id": "job", "model": CHECKER.MODEL, "requestHash": "hash",
                       "httpStatus": 200, "responseId": "response-1", "startedAt": "fixture-time",
                       "usage": {"totalTokenCount": 10, "cachedContentTokenCount": 2},
                       "finishReasons": ["STOP"], "images": [metadata(self.output, thought=False, candidateIndex=0, partIndex=0)]}
        self.raw = {"usageMetadata": self.record["usage"], "responseId": "response-1",
                    "candidates": [{"finishReason": "STOP", "content": {"parts": [self.raw_part(self.output)]}}]}
        self.persist()

    def raw_part(self, path, thought=False):
        return {"thought": thought, "inlineData": {"mimeType": metadata(path)["mimeType"],
                "data": base64.b64encode(path.read_bytes()).decode("ascii")}}

    def persist(self):
        save_json(self.run / "experiment.json", self.manifest)
        save_json(self.folder / "request.json", self.job)
        save_json(self.folder / "result.json", self.record)
        save_json(self.folder / "response-raw.json", self.raw)

    def check(self):
        self.persist()
        return CHECKER.check(self.run)

    def entry(self, result):
        return result["rooms"][0]["entries"][0]

    def kinds(self, result):
        return {i["kind"] for i in self.entry(result)["issues"]}

    def test_success_selects_nonthought_preserves_native_and_no_approval(self):
        thought = self.folder / "thought.png"
        Image.new("RGB", (80, 60), "red").save(thought)
        self.raw["candidates"][0]["content"]["parts"].append(self.raw_part(thought, True))
        self.record["images"].append(metadata(thought, thought=True, candidateIndex=0, partIndex=1))
        before = self.output.read_bytes()
        result = self.check()
        entry = self.entry(result)
        self.assertEqual(entry["status"], "technical-valid-but-structurally-unverified")
        self.assertEqual(entry["output"]["dimensions"], [2400, 1792])
        self.assertEqual(entry["output"]["path"], str(self.output))
        self.assertEqual(entry["finalImageCount"], 1)
        self.assertEqual(result["nativeDimensions"], {"2400x1792": 1})
        self.assertEqual(result["usage"]["generation"]["numericTotals"]["totalTokenCount"], 10)
        self.assertEqual(result["usage"]["generation"]["observedCacheHits"], 1)
        self.assertEqual(result["usage"]["reused"]["numericTotals"], {})
        self.assertFalse(entry["automaticApproval"])
        self.assertEqual(self.output.read_bytes(), before)
        self.assertIn("model-approximate-aspect", self.kinds(result))
        self.assertEqual(result["failures"], [])
        report = (self.run / "report.html").read_text()
        for marker in ("loading='lazy'", "Side by side", "A: original", "B: result", "alias&lt;&amp;&gt;",
                       "height:auto", "No MAE Ranking", "Provenance", "2400"):
            self.assertIn(marker, report)
        self.assertNotIn("room<1>", report)
        self.assertEqual((self.run / "report.html").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.run / "bulk-check.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.run / "bulk-check-assets").stat().st_mode & 0o777, 0o700)

    def test_source_hash_mismatch_and_failure_artifacts(self):
        self.manifest["rooms"][0]["source"]["sha256"] = "wrong"
        result = self.check()
        self.assertIn("source-sha256-mismatch", self.kinds(result))
        self.assertEqual(self.entry(result)["status"], "blocked")
        inputs = result["failures"][0]["judgingInputs"]
        self.assertEqual(len(inputs["crops"]), 12)
        for crop in inputs["crops"]:
            for role in ("source", "candidate"):
                path = Path(crop[role]["path"])
                self.assertTrue(path.is_relative_to(self.private))
                self.assertEqual(crop[role]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(inputs["fullPair"]["candidate"]["sha256"], metadata(self.output)["sha256"])

    def test_outcome_metadata_is_not_image_validity_and_usage_retained(self):
        for status in ("failed", "outcome-unknown", "in-flight-outcome-unknown"):
            with self.subTest(status=status):
                self.record["status"] = status
                result = self.check()
                self.assertEqual(self.entry(result)["imageStatus"], "valid")
                self.assertEqual(self.entry(result)["provenanceStatus"], "incomplete-or-inconsistent")
                self.assertIn("result-not-successful", self.kinds(result))
                self.assertEqual(result["usage"]["generation"]["numericTotals"]["totalTokenCount"], 10)
        (self.folder / "result.json").unlink()
        result = CHECKER.check(self.run)
        self.assertEqual(self.entry(result)["status"], "unavailable")
        self.assertEqual(self.entry(result)["visualReviewStatus"], "not-assessed")
        self.assertIn("explicit placeholder", (self.run / "report.html").read_text())
        self.manifest["jobs"] = []
        result = self.check()
        self.assertIn("candidate-missing", self.kinds(result))

    def test_transparency_dimensions_and_mime(self):
        for mode, size, color, expected in (
                ("RGBA", (2400, 1792), (10, 20, 30, 0), "output-transparency"),
                ("RGB", (640, 480), "gray", "output-not-highres"),
                ("RGB", (2400, 1800), "gray", "output-unexpected-dimensions")):
            with self.subTest(expected=expected):
                Image.new(mode, size, color).save(self.output)
                self.record["images"] = [metadata(self.output, thought=False, candidateIndex=0, partIndex=0)]
                self.raw["candidates"][0]["content"]["parts"] = [self.raw_part(self.output)]
                self.assertIn(expected, self.kinds(self.check()))
        self.record["images"][0]["mimeType"] = "image/jpeg"
        self.assertIn("output-mimeType-mismatch", self.kinds(self.check()))

    def test_ambiguity_and_bad_finish_are_not_success(self):
        self.record["images"].append({**self.record["images"][0], "partIndex": 1})
        self.raw["candidates"][0]["content"]["parts"].append(self.raw_part(self.output))
        self.assertIn("final-image-ambiguity", self.kinds(self.check()))
        self.raw["candidates"][0]["finishReason"] = "MAX_TOKENS"
        self.assertIn("invalid-finish", self.kinds(self.check()))

    def test_raw_bytes_missing_parts_and_frozen_settings(self):
        self.record["images"][0]["sha256"] = "changed"
        self.assertIn("raw-image-mismatch", self.kinds(self.check()))
        self.record["images"] = []
        self.assertIn("unsaved-response-part", self.kinds(self.check()))
        self.job["settings"]["imageConfig"]["imageSize"] = "1K"
        self.job["model"] = "another-model"
        result = self.check()
        self.assertIn("settings-mismatch", self.kinds(result))
        self.assertIn("model-mismatch", self.kinds(result))

    def test_reused_usage_is_historical_and_separate(self):
        self.record["usage"]["candidatesTokensDetails"] = [{"modality": "IMAGE", "tokenCount": 7},
                                                          {"modality": "TEXT", "tokenCount": 1}]
        self.manifest["reused"] = [{"roomId": "room<1>", "id": "reused", "resultPath": str(self.folder / "result.json"),
                                    "sourcePath": self.manifest["rooms"][0]["sourcePath"], "requestHash": "hash"}]
        result = self.check()
        self.assertEqual(result["counts"]["reusedPlanned"], 1)
        self.assertEqual(result["usage"]["reused"]["numericTotals"]["totalTokenCount"], 10)
        self.assertEqual(result["usage"]["generation"]["numericTotals"]["totalTokenCount"], 10)
        self.assertEqual(result["usage"]["generation"]["modalityTotals"]["candidatesTokensDetails"], {"IMAGE": 7, "TEXT": 1})
        self.assertEqual(result["rooms"][0]["entries"][1]["status"], "technical-valid-but-structurally-unverified")

    def test_color_drift_flags_not_mae_pass_and_authored_analysis_escaped(self):
        Image.new("RGB", (2400, 1792), "white").save(self.output)
        self.record["images"] = [metadata(self.output, thought=False, candidateIndex=0, partIndex=0)]
        self.raw["candidates"][0]["content"]["parts"] = [self.raw_part(self.output)]
        save_json(self.run / "failure-analysis.json", {"rooms": {"room<1>": {"reason": "<script>drift</script>"}}})
        result = self.check()
        self.assertEqual(self.entry(result)["status"], "heuristic-review-flag")
        self.assertIn("large-color-drift", self.kinds(result))
        self.assertFalse(result["policy"]["ranking"])
        self.assertIn("&lt;script&gt;drift&lt;/script&gt;", (self.run / "report.html").read_text())
        self.assertNotIn("<script>", (self.run / "report.html").read_text())

    def test_missing_source_decode_bad_raw_and_private_boundary(self):
        self.manifest["rooms"][0]["sourcePath"] = str(self.private / "missing.png")
        self.assertIn("source-unavailable", self.kinds(self.check()))
        self.manifest["rooms"][0]["sourcePath"] = str(Path(self.temp.name) / "outside.png")
        self.assertIn("source-unavailable", self.kinds(self.check()))
        self.persist()
        (self.folder / "response-raw.json").write_text("not json")
        result = CHECKER.check(self.run)
        self.assertIn("raw-response-unavailable", self.kinds(result))
        self.assertIsNotNone(self.entry(result)["output"])
        with self.assertRaises(ValueError):
            CHECKER.check(Path(self.temp.name))

    def test_source_transparency_dimensions_and_corrupt_output(self):
        source_path = Path(self.manifest["rooms"][0]["sourcePath"])
        Image.new("RGBA", (640, 480), (1, 2, 3, 254)).save(source_path)
        self.manifest["rooms"][0]["source"] = metadata(source_path)
        self.assertIn("source-transparency", self.kinds(self.check()))
        Image.new("RGB", (320, 240), "black").save(source_path)
        self.manifest["rooms"][0]["source"] = metadata(source_path)
        self.assertIn("source-dimensions", self.kinds(self.check()))
        self.output.write_bytes(b"not a decodable image")
        result = self.check()
        self.assertIn("output-unavailable", self.kinds(result))

    def test_missing_request_still_keeps_fullpair_and_usage(self):
        self.persist()
        (self.folder / "request.json").unlink()
        result = CHECKER.check(self.run)
        self.assertIn("request-evidence-unavailable", self.kinds(result))
        self.assertIsNotNone(self.entry(result)["output"])
        self.assertTrue(result["provenanceWarnings"])
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["usage"]["generation"]["numericTotals"]["totalTokenCount"], 10)

    def test_source_registry_exclusions_and_manifest_order(self):
        del self.manifest["exclusions"]
        self.manifest["sourceRegistry"] = {"exclusions": [{"roomId": "excluded", "reason": "UI"}]}
        self.manifest["rooms"].append({"id": "empty-room", "sourcePath": self.manifest["rooms"][0]["sourcePath"],
                                       "source": self.manifest["rooms"][0]["source"]})
        result = self.check()
        self.assertEqual(result["exclusions"][0]["reason"], "UI")
        self.assertEqual([room["id"] for room in result["rooms"]], ["room<1>", "empty-room"])
        self.assertEqual(result["rooms"][1]["entries"][0]["status"], "unavailable")

    def test_legacy_missing_raw_and_result_model_only_provenance_warning(self):
        del self.record['model']
        self.persist()
        (self.folder / 'response-raw.json').unlink()
        entry = self.entry(CHECKER.check(self.run))
        self.assertEqual(entry['imageStatus'], 'valid')
        self.assertEqual(entry['provenanceStatus'], 'incomplete-or-inconsistent')
        self.assertNotEqual(entry['status'], 'blocked')
        self.assertFalse(entry['automaticApproval'])
        self.assertEqual(entry['finalImageCount'], 1)
        self.assertIsNone(entry['rawFinalImageCount'])
        result = CHECKER.check(self.run)
        self.assertEqual(result['failures'], [])
        self.assertTrue(result['provenanceWarnings'])
        for item in entry['issues']:
            if item['kind'] in ('raw-response-unavailable', 'result-model-mismatch'):
                self.assertEqual(item['category'], 'provenance')

    def test_local_recolor_warns_despite_low_global_mean_drift(self):
        source = Image.new('RGB', (640, 480), (140, 80, 60))
        candidate = source.copy()
        ImageDraw.Draw(candidate).rectangle((160, 160, 239, 239), fill=(60, 140, 80))
        metrics = CHECKER.diagnostics(source, candidate)
        self.assertLess(max(abs(v) for v in metrics['meanDriftRGB']), 2)
        patches = metrics['localizedColor']['patches']
        self.assertIn('source-hue-shift', next(p for p in patches if p['id'] == 'r3c3')['warnings'])

    def test_texture_cleanup_and_dark_neutral_hue_are_not_hue_flags(self):
        yy, xx = np.indices((480, 640))
        pattern = np.where((xx + yy) % 2, 12, -12)[..., None]
        source = Image.fromarray((np.array([140, 80, 60]) + pattern).astype('uint8'))
        clean = Image.new('RGB', source.size, (140, 80, 60))
        self.assertFalse(any(p['warnings'] for p in CHECKER.color_patches(source, clean)['patches']))
        for color, changed in [((8, 2, 1), (1, 8, 2)), ((120, 119, 120), (119, 120, 119))]:
            patches = CHECKER.color_patches(Image.new('RGB', (640, 480), color),
                                             Image.new('RGB', (640, 480), changed))['patches']
            self.assertFalse(any(p['warnings'] for p in patches))

    def test_broad_red_to_orange_shift_is_not_hidden_by_18_degree_cutoff(self):
        source = Image.new('HSV', (640, 480), (0, 180, 160)).convert('RGB')
        candidate = source.copy()
        patch = Image.new('HSV', (80, 80), (8, 180, 160)).convert('RGB')
        candidate.paste(patch, (80, 160))
        cell = next(p for p in CHECKER.color_patches(source, candidate)['patches'] if p['id'] == 'r3c2')
        self.assertGreater(cell['medianHueShiftDegrees'], 8)
        self.assertLess(cell['medianHueShiftDegrees'], 18)
        self.assertIn('source-hue-shift', cell['warnings'])

    def test_low_edge_agreement_is_nonblocking_diagnostic(self):
        original = CHECKER.diagnostics
        def low_edges(source, candidate):
            return {**original(source, candidate), 'edgeGradientCosine': 0.01}
        with patch.object(CHECKER, 'diagnostics', low_edges):
            entry = self.entry(self.check())
        self.assertEqual(entry['imageStatus'], 'valid')
        self.assertEqual(entry['visualReviewStatus'], 'manual-review-required')
        edge = next(i for i in entry['issues'] if i['kind'] == 'low-edge-agreement')
        self.assertEqual(edge['severity'], 'diagnostic')

    def test_expanded_binding_dispositions_preserve_exclusions_and_unresolved(self):
        del self.manifest["exclusions"]
        self.manifest["sourceRegistry"] = {"dispositions": [
            {"disposition": "included", "reason": "verified"},
            {"disposition": "excluded", "reason": "UI"},
            {"disposition": "unresolved", "reason": "palette"}]}
        result = self.check()
        self.assertEqual([d["reason"] for d in result["exclusions"]], ["UI", "palette"])
        report = (self.run / "report.html").read_text()
        self.assertIn("Excluded and Unresolved Original Bindings (2)", report)

    def test_catalog_price_separates_image_text_and_thought_tokens_not_billing(self):
        usage = {"promptTokenCount": 40140, "candidatesTokenCount": 50528, "thoughtsTokenCount": 25636,
                 "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 50400},
                                             {"modality": "TEXT", "tokenCount": 128}]}
        result = CHECKER.usage_totals([("one", usage, "response-one", True),
                                      ("duplicate", usage, "response-one", True)])
        self.assertEqual(result["returnedResponseRecords"], 1)
        self.assertAlmostEqual(result["catalogPriceEstimate"]["usd"], 1.76544)
        self.assertEqual(result["catalogPriceEstimate"]["unclassifiedCandidateTokens"], 0)
        self.assertFalse(result["catalogPriceEstimate"]["confirmedBilling"])
        self.assertEqual(result["observedCacheHits"], 0)

    def test_calibration_only_eight_secondary_metrics(self):
        path = self.private / "upscaling/gemini-experiments/opaque-pilot-v1/eval.json"
        path.parent.mkdir(parents=True)
        save_json(path, {"rooms": [{"entries": [{"kind": "candidate", "metrics": {
            "edgeGradientCosine": 0.5, "meanDriftRGB": [1, 2, 3]}, "decision": {"verdict": "reject"}}] * 8}]})
        value = CHECKER.calibration()
        self.assertEqual(value["sampleCount"], 8)
        self.assertEqual(value["thresholds"]["edgeCosineBelow"], 0.35)
        self.assertNotIn("decision", json.dumps(value))

    def test_cli_is_offline_only(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertNotIn("--execute", result.stdout)
        source = SCRIPT.read_text()
        for forbidden in ("import requests", "import urllib.request", "subprocess", "gcloud"):
            self.assertNotIn(forbidden, source)

    def native_fixture(self, source_size=(640, 500), output_size=(2400, 1872)):
        source_path = Path(self.manifest["rooms"][0]["sourcePath"])
        self.source.resize(source_size).save(source_path)
        self.manifest["rooms"][0]["source"] = metadata(source_path)
        self.job["attachments"] = [metadata(source_path, role="source-composition")]
        self.job["sourceGeometryPolicy"] = {
            "mode": "preserve-native-aspect", "sourceDimensions": [640, 500],
            "reason": "User authorized complete native640x500 source; no crop/pad/stretch; aspectRatio omitted torequest source-nativegeometry"}
        self.job["settings"]["imageConfig"] = {"imageSize": "2K"}
        with Image.open(source_path) as source:
            source.resize(output_size, Image.Resampling.LANCZOS).save(self.output)
        self.record["images"] = [metadata(self.output, thought=False, candidateIndex=0, partIndex=0)]
        self.raw["candidates"][0]["content"]["parts"] = [self.raw_part(self.output)]

    def test_authorized_native_aspect_is_valid_with_caveat_not_approval(self):
        self.native_fixture()
        source_path = Path(self.manifest["rooms"][0]["sourcePath"])
        before = (source_path.read_bytes(), self.output.read_bytes())
        entry = self.entry(self.check())
        self.assertEqual(entry["imageStatus"], "valid")
        self.assertEqual(entry["provenanceStatus"], "complete")
        self.assertTrue(entry["inputGeometryPolicy"]["nativeAspectExceptionAccepted"])
        self.assertEqual(entry["inputGeometryPolicy"]["declared"], entry["inputGeometryPolicy"]["frozenRequest"])
        geometry = entry["geometryDiagnostics"]
        self.assertEqual(geometry["outputDimensions"], [2400, 1872])
        self.assertAlmostEqual(geometry["sourceAspectRatio"], 640 / 500)
        self.assertAlmostEqual(geometry["outputAspectRatio"], 2400 / 1872)
        self.assertAlmostEqual(geometry["aspectRatioDelta"], 2400 / 1872 - 640 / 500)
        self.assertTrue(geometry["manualFullViewRequired"])
        mismatch = next(i for i in entry["issues"] if i["kind"] == "output-unexpected-dimensions")
        self.assertEqual(mismatch["severity"], "caveat")
        self.assertFalse(entry["automaticApproval"])
        self.assertEqual(before, (source_path.read_bytes(), self.output.read_bytes()))

    def test_native_policy_lie_or_forced_ratio_warns_not_image_bad(self):
        for source_size, forced_ratio in (((640, 480), False), ((640, 500), True)):
            with self.subTest(source_size=source_size, forced_ratio=forced_ratio):
                self.native_fixture(source_size)
                if forced_ratio:
                    self.job["settings"]["imageConfig"]["aspectRatio"] = "4:3"
                entry = self.entry(self.check())
                self.assertEqual(entry["imageStatus"], "valid")
                self.assertEqual(entry["provenanceStatus"], "incomplete-or-inconsistent")
                self.assertFalse(entry["inputGeometryPolicy"]["nativeAspectExceptionAccepted"])
                self.assertTrue(any(i["kind"] == ("settings-mismatch" if forced_ratio else "geometry-policy-mismatch")
                                    and i["severity"] == "provenance-warning" for i in entry["issues"]))

    def test_native_policy_must_be_in_frozen_request(self):
        self.native_fixture()
        self.persist()
        request = {k: v for k, v in self.job.items() if k != "sourceGeometryPolicy"}
        save_json(self.folder / "request.json", request)
        entry = self.entry(CHECKER.check(self.run))
        self.assertIn("request-sourceGeometryPolicy-mismatch", {i["kind"] for i in entry["issues"]})
        self.assertFalse(entry["inputGeometryPolicy"]["nativeAspectExceptionAccepted"])
        self.assertEqual(entry["imageStatus"], "valid")

    def test_native_settings_require_omitted_ratio_2k_and_exact_modes(self):
        for config, modes in (({"imageSize": "2K", "aspectRatio": None}, ["TEXT", "IMAGE"]),
                              ({"imageSize": "1K"}, ["TEXT", "IMAGE"]),
                              ({"imageSize": "2K"}, ["IMAGE"]),
                              ({"imageSize": "2K"}, ["TEXT", "IMAGE", "OTHER"])):
            with self.subTest(config=config, modes=modes):
                self.native_fixture()
                self.job["settings"] = {"imageConfig": config, "responseModalities": modes}
                entry = self.entry(self.check())
                self.assertFalse(entry["inputGeometryPolicy"]["nativeAspectExceptionAccepted"])
                self.assertIn("settings-mismatch", {i["kind"] for i in entry["issues"]})

    def test_standard_dimensions_stay_hard_and_arbitrary_policy_cannot_bypass(self):
        self.native_fixture(source_size=(640, 480))
        self.job["settings"]["imageConfig"]["aspectRatio"] = "4:3"
        for policy in (None, {"mode": "anything"}, {"mode": "preserve-native-aspect",
                       "sourceDimensions": [640, 480], "reason": "not the authorized exception"}):
            with self.subTest(policy=policy):
                self.job["sourceGeometryPolicy"] = policy
                entry = self.entry(self.check())
                self.assertEqual(entry["imageStatus"], "invalid")
                self.assertTrue(any(i["kind"] == "output-unexpected-dimensions" and
                                    i["severity"] == "hard-technical-failure" for i in entry["issues"]))

    def test_native_small_huge_or_transparent_remains_invalid(self):
        for size, transparent in (((1280, 1000), False), ((4000, 3125), False), ((2400, 1872), True)):
            with self.subTest(size=size, transparent=transparent):
                self.native_fixture(output_size=size)
                if transparent:
                    Image.new("RGBA", size, (30, 40, 50, 0)).save(self.output)
                    self.record["images"] = [metadata(self.output, thought=False, candidateIndex=0, partIndex=0)]
                    self.raw["candidates"][0]["content"]["parts"] = [self.raw_part(self.output)]
                self.assertEqual(self.entry(self.check())["imageStatus"], "invalid")

    def test_text_profile_always_has_four_paired_native_crops_no_ocr_or_verdict(self):
        self.manifest["rooms"][0]["textInspection"] = {"required": True, "kind": "source-inscriptions"}
        before = self.output.read_bytes()
        entry = self.entry(self.check())
        self.assertEqual(entry["imageStatus"], "valid")
        self.assertFalse(any(i["severity"] == "heuristic-review-flag" for i in entry["issues"]))
        text = entry["textDiagnostics"]
        self.assertFalse(text["ocrPerformed"])
        self.assertFalse(text["automaticApproval"])
        self.assertFalse(text["letterFidelityAssessed"])
        self.assertTrue(text["manualReviewRequired"])
        self.assertIn("not OCR or recognized words", text["note"])
        self.assertEqual(len(entry["judgingInputs"]["crops"]), 4)
        for crop in entry["judgingInputs"]["crops"]:
            for role, size in (("source", (160, 480)), ("candidate", (600, 1792))):
                path = Path(crop[role]["path"])
                self.assertTrue(path.exists())
                with Image.open(path) as image:
                    self.assertEqual(image.size, size)
                self.assertEqual(crop[role]["sha256"], metadata(path)["sha256"])
        self.assertEqual(self.output.read_bytes(), before)

    def test_text_profile_is_source_defined_counts_only_manual_hints(self):
        unchanged = CHECKER.text_layout(self.source, self.source)
        changed = CHECKER.text_layout(self.source, Image.new("RGB", self.source.size, "white"))
        self.assertEqual(unchanged["sourceContrastThreshold"], changed["sourceContrastThreshold"])
        for a, b in zip(unchanged["regions"], changed["regions"]):
            self.assertEqual(a["box"], b["box"])
            self.assertEqual(a["source"], b["source"])
        self.assertTrue(any(r["contrastBandCountDelta"] for r in changed["regions"]))
        self.assertNotIn("recognizedWords", changed)
        self.assertNotIn("verdict", changed)
        self.assertFalse(changed["automaticApproval"])
        self.assertNotIn("textDiagnostics", self.entry(self.check()))

    def test_frozen_source_band_defines_paired_columns_not_candidate(self):
        profile = {"required": True, "kind": "source-inscriptions", "band": [0, .06, 1, .74]}
        self.manifest["rooms"][0]["textInspection"] = profile
        entry = self.entry(self.check())
        self.assertEqual(entry["textDiagnostics"]["band"], profile["band"])
        for index, crop in enumerate(entry["judgingInputs"]["crops"]):
            self.assertEqual(crop["box"], [index / 4, .06, (index + 1) / 4, .74])
            with Image.open(crop["source"]["path"]) as image:
                self.assertEqual(image.size, (160, int(.74 * 480) - int(.06 * 480)))
            with Image.open(crop["candidate"]["path"]) as image:
                self.assertEqual(image.size, (600, int(.74 * 1792) - int(.06 * 1792)))
        changed = CHECKER.text_layout(self.source, Image.new("RGB", self.source.size, "white"), profile)
        self.assertEqual(changed["regions"][0]["source"], entry["textDiagnostics"]["regions"][0]["source"])


if __name__ == "__main__":
    unittest.main()
