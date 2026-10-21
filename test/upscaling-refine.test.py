"""Synthetic offline evidence for RGB-guided geometric mask refinement."""

import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np
from PIL import Image
from scipy import ndimage as ndi


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("static_refine", ROOT / "tools/upscaling/static/refine.py")
refine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refine)


def image(mask):
    return Image.fromarray(mask.astype(np.uint8) * 255)


def rgb(mask):
    return Image.fromarray(np.where(mask[:, :, None], [185, 105, 45], [30, 55, 85]).astype(np.uint8))


class RefineTests(unittest.TestCase):
    def circle(self, shift=0):
        y, x = np.indices((40, 44))
        native = (x - 21.5) ** 2 + (y - 19.5) ** 2 < 13 ** 2
        y, x = np.indices((160, 176))
        truth = (x + 0.5 - (22 * 4 + shift)) ** 2 + (y + 0.5 - 20 * 4) ** 2 < 52 ** 2
        return native, truth

    def test_genuine_rgb_sensitivity_and_accuracy(self):
        native, left = self.circle(-5)
        _, right = self.circle(5)
        a = refine.refine_mask(image(native), rgb(left))
        b = refine.refine_mask(image(native), rgb(right))
        am, bm = np.asarray(a["binaryMask"]) > 0, np.asarray(b["binaryMask"]) > 0
        baseline = native.repeat(4, 0).repeat(4, 1)
        for result, mask, truth in ((a, am, left), (b, bm, right)):
            self.assertLess(np.count_nonzero(mask != truth), np.count_nonzero(baseline != truth) * 0.35)
            self.assertTrue(result["diagnostics"]["topologyPreserved"])
            self.assertFalse(result["diagnostics"]["reviewRequired"])
            self.assertGreater(result["diagnostics"]["edgeSupportFraction"], 0.6)
            self.assertLessEqual(result["diagnostics"]["displacementHD"]["maxSymmetric"], 12)
            self.assertEqual(result["diagnostics"]["changedOutsideTrustBand"], 0)
        self.assertGreater(np.count_nonzero(am != bm), 1000)

    def test_fewer_native_scale_stairs(self):
        native, truth = self.circle()
        result = refine.refine_mask(image(native), rgb(truth))
        mask = np.asarray(result["binaryMask"]) > 0
        baseline = native.repeat(4, 0).repeat(4, 1)

        def repeated_steps(value):
            # Left silhouette: NN makes long constant x runs, followed by 4px jumps.
            x = np.argmax(value[35:125], axis=1)
            return np.count_nonzero(np.abs(np.diff(x)) >= 4)

        self.assertLess(repeated_steps(mask), repeated_steps(baseline) * 0.4)
        self.assertLess(np.count_nonzero(mask != truth), np.count_nonzero(baseline != truth) * 0.3)

    def test_thin_ring_and_narrow_rung_holes(self):
        y, x = np.indices((35, 35))
        radius = np.hypot(x - 17, y - 17)
        ring = (radius >= 11) & (radius < 13)
        y, x = np.indices((140, 140))
        r = np.hypot(x + 0.5 - 70, y + 0.5 - 70)
        truth = (r >= 44) & (r < 52)
        result = refine.refine_mask(image(ring), rgb(truth))
        self.assertEqual(result["diagnostics"]["outputTopology"], {"components": 1, "holes": 1})
        self.assertTrue(result["diagnostics"]["topologyPreserved"])
        ladder = np.zeros((30, 20), bool)
        ladder[2:28, 3:5] = True
        ladder[2:28, 14:16] = True
        ladder[2:4, 3:16] = True
        ladder[14:15, 3:16] = True
        ladder[26:28, 3:16] = True
        ladder[6:7, 3:16] = True
        ladder[8:9, 3:16] = True
        hd = ladder.repeat(4, 0).repeat(4, 1)
        result = refine.refine_mask(image(ladder), rgb(hd))
        self.assertEqual(result["diagnostics"]["outputTopology"], {"components": 1, "holes": 4})
        self.assertTrue(result["diagnostics"]["topologyPreserved"])

    def test_constant_rgb_is_smooth_prior_not_boundary_proof(self):
        native, _ = self.circle()
        result = refine.refine_mask(image(native), Image.new("RGB", (176, 160), (80, 80, 80)))
        self.assertTrue(result["diagnostics"]["reviewRequired"])
        self.assertEqual(result["diagnostics"]["edgeSupportFraction"], 0)
        self.assertEqual(result["diagnostics"]["colorConfidence"], 0)
        mask = np.asarray(result["binaryMask"]) > 0
        self.assertFalse(np.array_equal(mask, native.repeat(4, 0).repeat(4, 1)))
        self.assertTrue(result["diagnostics"]["topologyPreserved"])

    def test_fine_texture_does_not_become_silhouette(self):
        native, truth = self.circle(4)
        donor = np.asarray(rgb(truth), dtype=float)
        y, x = np.indices(truth.shape)
        texture = 18 * np.sin(x * 1.7) * np.cos(y * 1.3)
        donor = Image.fromarray(np.clip(donor + texture[:, :, None], 0, 255).astype(np.uint8))
        result = refine.refine_mask(image(native), donor)
        mask = np.asarray(result["binaryMask"]) > 0
        self.assertLess(np.count_nonzero(mask != truth), 100)
        self.assertTrue(result["diagnostics"]["topologyPreserved"])
        json.dumps(result["diagnostics"], allow_nan=False)
        self.assertFalse(result["diagnostics"]["automaticApproval"])

    def test_topology_failure_is_reported_and_not_nn_fixed(self):
        native, truth = self.circle()
        # RGB proposes a large new hole inside the allowed band. Its seed is
        # absent in the source; the cut must not silently approve new topology.
        truth[74:86, 118:130] = False
        result = refine.refine_mask(image(native), rgb(truth), band_native=15)
        diagnostic = result["diagnostics"]
        self.assertTrue(diagnostic["candidateRejected"])
        self.assertTrue(diagnostic["reviewRequired"])
        self.assertNotEqual(diagnostic["candidateTopology"], diagnostic["sourceTopology"])
        self.assertEqual(diagnostic["outputTopology"], diagnostic["sourceTopology"])
        self.assertFalse(np.array_equal(np.asarray(result["binaryMask"]) > 0,
                                       native.repeat(4, 0).repeat(4, 1)))

    def test_tiny_band_displacement_is_not_hidden(self):
        native, _ = self.circle()
        result = refine.refine_mask(image(native), Image.new("RGB", (176, 160)), band_native=0.01)
        diagnostic = result["diagnostics"]
        self.assertGreater(diagnostic["changedOutsideTrustBand"], 0)
        self.assertIn("changed-outside-trust-band", diagnostic["reviewReasons"])

    def test_rgb_closed_exterior_portal_is_reopened_not_hole_filled(self):
        # Like the real ladder crop: the first opening escapes through an
        # occluded left rail, while the second opening is an intended hole.
        native = np.zeros((32, 26), dtype=bool)
        native[4:29, 4:7] = True
        native[4:29, 19:22] = True
        native[4:7, 4:22] = True
        native[16:19, 4:22] = True
        native[26:29, 4:22] = True
        native[9:11, 4:7] = False
        truth = native.repeat(4, 0).repeat(4, 1)
        truth[36:44, 16:28] = True
        truth = ndi.shift(truth, (0, 3), order=0, mode="constant")
        result = refine.refine_mask(image(native), rgb(truth), return_debug_masks=True)
        diagnostic = result["diagnostics"]
        self.assertEqual(diagnostic["candidateTopology"], {"components": 1, "holes": 2})
        self.assertEqual(diagnostic["outputTopology"], {"components": 1, "holes": 1})
        self.assertTrue(diagnostic["candidateCorrected"])
        self.assertTrue(diagnostic["reviewRequired"])
        self.assertFalse(diagnostic["automaticApproval"])
        self.assertEqual(diagnostic["outputBasis"],
                         "rgb-graph-cut-with-reviewed-exterior-reconnection")
        mask = np.asarray(result["binaryMask"]) > 0
        raw = np.asarray(result["rawCandidateMask"]) > 0
        prior = np.asarray(result["priorMask"]) > 0
        changed = mask != raw
        self.assertTrue(np.all(~mask[changed]))
        self.assertTrue(np.all(~prior[changed]))
        self.assertLessEqual(np.count_nonzero(changed), 24)
        self.assertGreater(np.count_nonzero(mask != prior), 300)
        self.assertEqual(diagnostic["changedOutsideTrustBand"], 0)
        self.assertGreater(diagnostic["topologyCorrections"][0]["rawHoleArea"], 1000)
        self.assertEqual(len(diagnostic["topologyCorrections"][0]["removedForegroundXY"]),
                         np.count_nonzero(changed))
        self.assertGreater(diagnostic["edgeSupportFraction"], 0.7)
        self.assertTrue(np.all(~mask[30:60, 35:65]))
        json.dumps(diagnostic, allow_nan=False)

    def test_geometric_displacement_is_not_the_sdf_band_bound(self):
        native, truth = self.circle(8)
        result = refine.refine_mask(image(native), rgb(truth))
        diagnostic = result["diagnostics"]
        self.assertFalse(diagnostic["displacementHD"]["hardBound"])
        self.assertIn("pixel-center", diagnostic["displacementHD"]["definition"])
        self.assertIn("interpolated native", diagnostic["trustBandDefinition"])

    def test_exterior_safeguard_refuses_substantial_rail_tearing(self):
        prior = np.zeros((60, 60), dtype=bool)
        prior[10:50, 10:50] = True
        prior[20:40, 20:40] = False
        prior[25:27, 10:20] = False
        candidate = prior.copy()
        candidate[25:27, 10:20] = True
        zero = np.zeros(prior.shape, dtype=float)
        repaired, corrections = refine._reconnect_exterior(
            candidate, prior, np.ones_like(prior), zero, zero, band=2)
        self.assertEqual(corrections, [])
        np.testing.assert_array_equal(repaired, candidate)

    def test_coverage_is_local_and_inputs_not_mutated(self):
        native, truth = self.circle(3)
        source, donor = image(native), rgb(truth)
        before = source.tobytes(), donor.tobytes()
        result = refine.refine_mask(source, donor)
        self.assertEqual(before, (source.tobytes(), donor.tobytes()))
        mask = np.asarray(result["binaryMask"])
        self.assertEqual(set(np.unique(mask)), {0, 255})
        coverage = np.asarray(result["coverageAlpha"])
        self.assertEqual(result["coverageAlpha"].mode, "L")
        self.assertTrue(np.any((coverage > 0) & (coverage < 255)))
        interior = ndi.binary_erosion(mask > 0)
        exterior = ndi.binary_erosion(mask == 0)
        self.assertTrue(np.all(coverage[interior] == 255))
        self.assertTrue(np.all(coverage[exterior] == 0))
        self.assertIsNone(refine.refine_mask(source, donor, coverage_samples=1)["coverageAlpha"])

    def test_crop_border_and_uniform_masks(self):
        native = np.zeros((20, 20), bool)
        native[:16, :13] = True
        hd = native.repeat(4, 0).repeat(4, 1)
        result = refine.refine_mask(image(native), rgb(hd))
        mask = np.asarray(result["binaryMask"]) > 0
        self.assertTrue(np.all(mask[0, :40]))
        self.assertTrue(np.all(mask[:50, 0]))
        for state in (False, True):
            native[:] = state
            result = refine.refine_mask(image(native), rgb(native.repeat(4, 0).repeat(4, 1)))
            self.assertTrue(np.all((np.asarray(result["binaryMask"]) > 0) == state))
            self.assertTrue(result["diagnostics"]["reviewRequired"])

    def test_validation(self):
        source = Image.new("L", (8, 9))
        donor = Image.new("RGB", (32, 36))
        for scale in (True, 0, -1, 1.5, "4"):
            with self.subTest(scale=scale), self.assertRaises(ValueError):
                refine.refine_mask(source, donor, scale=scale)
        for band in (True, 0, -1, np.nan, np.inf, "3"):
            with self.subTest(band=band), self.assertRaises(ValueError):
                refine.refine_mask(source, donor, band_native=band)
        for size in ((31, 36), (32, 37), (36, 32)):
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "dimensions"):
                refine.refine_mask(source, Image.new("RGB", size))
        for name, value in (("smoothness", -1), ("color_weight", np.inf),
                            ("shape_weight", np.nan), ("edge_sigma", 0),
                            ("coverage_samples", 9), ("coverage_samples", 1.5),
                            ("return_debug_masks", 1)):
            with self.subTest(name=name), self.assertRaises(ValueError):
                refine.refine_mask(source, donor, **{name: value})
        with self.assertRaises(ValueError):
            refine.refine_mask(source.convert("RGB"), donor)
        with self.assertRaises(ValueError):
            refine.refine_mask(source, donor.convert("RGBA"))
        with self.assertRaises(ValueError):
            refine.refine_mask(Image.new("L", (8, 9), 128), donor)


if __name__ == "__main__":
    unittest.main()
