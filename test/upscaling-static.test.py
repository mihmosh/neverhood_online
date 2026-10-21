"""Synthetic offline tests for RGB processing and explicit nearest-mask controls."""

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("static_pipeline", ROOT / "tools/upscaling/static/pipeline.py")
pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pipeline)


class StaticPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = np.zeros((3, 4, 4), dtype=np.uint8)
        self.source[:, :, :3] = [255, 0, 255]
        self.source[1:, 1:3] = [20, 100, 40, 255]
        self.path = self.save("source.png", self.source)
        self.asset = {"id": "synthetic-asset", "kind": "static-prop",
                      "sourcePath": str(self.path), "sourceSHA256": pipeline._hash(self.path),
                      "contentSize": [4, 3], "canvasSize": [6, 5], "placement": [2, 1],
                      "sourceIdentity": {"resource": "abc", "nested": {"pivot": [2, 1]}}}

    def save(self, name, data):
        path = self.root / name
        Image.fromarray(data).save(path)
        return path

    def process(self, **kwargs):
        kwargs.setdefault("mask_method", "source-nearest")
        return pipeline.process_asset(self.asset, self.root / "output", **kwargs)

    def pixels(self, result, key):
        with Image.open(result["outputs"][key]["path"]) as image:
            return np.asarray(image).copy()

    def test_foreground_exact_rgb_and_padded_mask(self):
        self.asset.update(kind="foreground-occluder", backgroundCorrespondence="explicit-scene-binding")
        bg = np.arange(12 * 16 * 3, dtype=np.uint8).reshape(12, 16, 3)
        background = self.save("background.png", bg)
        original = np.zeros((6, 8, 3), dtype=np.uint8)
        original[1:4, 2:6] = self.source[:, :, :3]
        self.asset["originalBackgroundPath"] = str(self.save("original.png", original))
        result = self.process(scale=2, background_path=background, scene_size=(8, 6))
        output = self.pixels(result, "rgba")
        expected = np.zeros((10, 12), dtype=np.uint8)
        expected[:6, :8] = self.source[:, :, 3].repeat(2, 0).repeat(2, 1)
        np.testing.assert_array_equal(output[:, :, 3], expected)
        np.testing.assert_array_equal(self.pixels(result, "mask"), expected)
        np.testing.assert_array_equal(output[:6, :8, :3][expected[:6, :8] == 255],
                                      bg[2:8, 4:12][expected[:6, :8] == 255])
        self.assertTrue(np.all(output[expected == 0, :3] == 0))
        self.assertEqual(result["placement"], [2, 1])
        self.assertEqual(result["scaledPlacement"], [4, 2])
        self.assertEqual(result["sourceIdentity"], self.asset["sourceIdentity"])
        self.assertTrue(result["diagnostics"]["sourceOriginalBackgroundVisibleRGB"]["exactMatch"])
        self.assertEqual(result["acceptance"], "review-required")
        self.assertTrue(result["invariants"]["alpha"]["exactEquality"])

    def test_donor_alpha_ignored_and_padding_cropped_at_origin(self):
        donor = np.zeros((10, 12, 4), dtype=np.uint8)
        donor[:, :, :3] = [7, 80, 190]
        donor[:, 8:, :3] = [255, 0, 255]
        donor[6:, :, :3] = [255, 0, 255]
        result = self.process(scale=2, rgb_path=self.save("donor.png", donor))
        output = self.pixels(result, "rgba")
        np.testing.assert_array_equal(output[output[:, :, 3] == 255, :3],
                                      np.tile([7, 80, 190], (16, 1)))
        self.assertEqual(output.shape, (10, 12, 4))
        self.assertTrue(result["inputs"]["rgb"]["alphaIgnored"])
        self.assertEqual(result["inputs"]["rgb"]["cropOrigin"], [0, 0])
        self.assertEqual(result["placement"], [2, 1])

    def test_content_size_donor_and_invalid_dimensions(self):
        donor = self.save("bad.png", np.zeros((7, 8, 3), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.process(scale=2, rgb_path=donor)
        donor = self.save("good.png", np.full((6, 8, 3), 55, dtype=np.uint8))
        result = self.process(scale=2, rgb_path=donor)
        output = self.pixels(result, "rgba")
        self.assertTrue(np.all(output[output[:, :, 3] == 255, :3] == 55))

    def test_premultiplied_baseline_no_magenta_or_dark_halo(self):
        result = self.process(scale=4)
        output = self.pixels(result, "rgba")
        visible = output[:, :, 3] == 255
        np.testing.assert_array_equal(output[visible, :3], np.tile([20, 100, 40], (64, 1)))
        self.assertTrue(np.all(output[~visible, :3] == 0))
        self.assertIn("baseline", result["processingMethods"]["rgb"])
        baseline = self.pixels(result, "sourceNN")
        np.testing.assert_array_equal(baseline[:, :, 3], output[:, :, 3])

    def test_resume_unchanged_and_hash_verified(self):
        result = self.process(scale=2)
        paths = [Path(item["path"]) for item in result["outputs"].values()] + [Path(result["resultPath"])]
        before = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        self.assertEqual(self.process(scale=2), result)
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths])
        self.assertEqual(json.loads(paths[-1].read_text()), result)
        for item in result["outputs"].values():
            self.assertEqual(item["sha256"], hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest())
        Image.new("RGBA", (12, 10)).save(paths[0])
        with self.assertRaisesRegex(ValueError, "hash/path"):
            self.process(scale=2)

    def test_stale_parameters_and_stale_source_fail(self):
        self.process(scale=2)
        with self.assertRaisesRegex(ValueError, "stale"):
            self.process(scale=3)
        self.source[1, 1, 0] = 80
        self.save("source.png", self.source)
        with self.assertRaisesRegex(ValueError, "SHA256"):
            self.process(scale=2)
        self.asset["sourceSHA256"] = pipeline._hash(self.path)
        with self.assertRaisesRegex(ValueError, "stale"):
            self.process(scale=2)

    def test_changed_donor_fails_resume(self):
        donor = self.save("donor.png", np.zeros((6, 8, 3), dtype=np.uint8))
        self.process(scale=2, rgb_path=donor)
        self.save("donor.png", np.full((6, 8, 3), 10, dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "stale"):
            self.process(scale=2, rgb_path=donor)

    def test_tampered_or_partial_existing_result_is_never_overwritten(self):
        result = self.process(scale=2)
        path = Path(result["resultPath"])
        tampered = dict(result, placement=[100, 100])
        path.write_text(json.dumps(tampered))
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "manifest hash"):
            self.process(scale=2)
        self.assertEqual(path.read_bytes(), before)
        path.unlink()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.process(scale=2)
        self.assertFalse(path.exists())

    def test_scale_and_safe_identifier(self):
        for scale in (True, False, 0, -1, 1.2, "4"):
            with self.subTest(scale=scale), self.assertRaises(ValueError):
                self.process(scale=scale)
        for identifier in ("..", "../escape", "/absolute", "a/b", "a\\b", ""):
            self.asset["id"] = identifier
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.process()

    def test_source_validation(self):
        variants = [np.zeros((3, 4, 3), dtype=np.uint8), np.zeros((3, 4, 4), dtype=np.uint8), self.source.copy()]
        variants[-1][0, 0, 3] = 127
        for data in variants:
            self.save("source.png", data)
            self.asset["sourceSHA256"] = pipeline._hash(self.path)
            with self.subTest(shape=data.shape), self.assertRaises(ValueError):
                self.process()
        self.save("source.png", self.source)
        self.asset["sourceSHA256"] = pipeline._hash(self.path)
        self.asset["contentSize"] = [5, 3]
        with self.assertRaisesRegex(ValueError, "dimensions"):
            self.process()
        self.asset["contentSize"] = [4, 3]
        self.asset["canvasSize"] = [3, 3]
        with self.assertRaisesRegex(ValueError, "canvasSize"):
            self.process()

    def test_foreground_binding_background_size_and_bounds(self):
        self.asset["kind"] = "foreground-occluder"
        background = self.save("background.png", np.zeros((12, 16, 3), dtype=np.uint8))
        with self.assertRaisesRegex(ValueError, "binding"):
            self.process(scale=2, background_path=background, scene_size=(8, 6))
        self.asset["backgroundCorrespondence"] = "explicit-scene-binding"
        with self.assertRaisesRegex(ValueError, "no autoresize"):
            self.process(scale=3, background_path=background, scene_size=(8, 6))
        self.asset["placement"] = [6, 1]
        with self.assertRaisesRegex(ValueError, "bounds"):
            self.process(scale=2, background_path=background, scene_size=(8, 6))

    def test_alpha_holes_components_and_legacy_soft_counts(self):
        mask = np.zeros((9, 9), dtype=np.uint8)
        mask[1:6, 1:6] = 255
        mask[2:5, 2:5] = 0
        mask[7, 7] = 255
        candidate = mask.copy()
        candidate[1, 1] = 180
        candidate[0, 0] = 12
        comparison = pipeline.compare_alpha(mask, candidate)
        self.assertEqual(comparison["reference"]["components"], 2)
        self.assertEqual(comparison["reference"]["holes"], 1)
        self.assertEqual(comparison["reference"]["opaqueCount"], 17)
        self.assertEqual(comparison["candidate"]["softCount"], 2)
        self.assertEqual(comparison["mismatchCount"], 2)
        self.assertEqual(comparison["thresholdIoU"], 1.0)
        self.assertFalse(comparison["exactEquality"])
        with self.assertRaises(ValueError):
            pipeline.compare_alpha(mask, candidate[:-1])
        diagonal = np.array([[255, 0], [0, 255]], dtype=np.uint8)
        self.assertEqual(pipeline.compare_alpha(diagonal, diagonal)["reference"]["components"], 2)

    def test_default_refines_the_restored_object_not_the_source_stairs(self):
        yy, xx = np.indices((32, 32))
        coarse = (xx - 16) ** 2 + (yy - 16) ** 2 < 9 ** 2
        source = np.zeros((32, 32, 4), np.uint8)
        source[:, :, :3] = [220, 130, 80]
        source[:, :, 3] = coarse * 255
        path = self.save("coarse-circle.png", source)
        hy, hx = np.indices((128, 128))
        truth = (hx - 66) ** 2 + (hy - 64) ** 2 < 36 ** 2
        rgb = np.where(truth[:, :, None], [220, 130, 80], [30, 70, 125]).astype(np.uint8)
        rgb_path = self.save("restored-circle.png", rgb)
        asset = {**self.asset, "id": "guided-circle", "sourcePath": str(path), "sourceSHA256": pipeline._hash(path),
                 "contentSize": [32, 32], "canvasSize": [34, 33]}
        # No mask_method override: image guidance must be the actual default.
        result = pipeline.process_asset(asset, self.root / "output", rgb_path=rgb_path)
        refined = self.pixels(result, "mask")[:128, :128] > 0
        nearest = coarse.repeat(4, 0).repeat(4, 1)
        self.assertLess(np.count_nonzero(refined != truth), np.count_nonzero(nearest != truth))
        self.assertGreater(np.count_nonzero(refined != nearest), 0)
        self.assertEqual(result["processingMethods"]["alpha"], "image-guided")
        self.assertTrue(result["invariants"]["topologyPreserved"])
        self.assertFalse(result["invariants"]["sourceMaskComparisonIsAcceptanceCriterion"])
        coverage = self.pixels(result, "coverage")
        self.assertTrue(np.any((coverage > 0) & (coverage < 255)))
        self.assertTrue(np.all(coverage[128:] == 0))
        self.assertTrue(np.all(coverage[:, 128:] == 0))
        self.assertEqual(result["sourceIdentity"], asset["sourceIdentity"])
        self.assertEqual(pipeline.process_asset(asset, self.root / "output", rgb_path=rgb_path), result)

    def test_guidance_cannot_silently_use_source_upscale_or_masked_donor_colors(self):
        with self.assertRaisesRegex(ValueError, "require restored RGB"):
            pipeline.process_asset(self.asset, self.root / "output")
        donor = self.save("masked-donor.png", np.zeros((12, 16, 4), np.uint8))
        with self.assertRaisesRegex(ValueError, "opaque RGB context"):
            pipeline.process_asset(self.asset, self.root / "output", rgb_path=donor)


if __name__ == "__main__":
    unittest.main()
