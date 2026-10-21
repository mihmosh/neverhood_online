import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/upscaling/static"))
import prepared as PREPARED

SPEC = importlib.util.spec_from_file_location("prepared_pilot_fixture", ROOT / "test/upscaling-static-pilot.test.py")
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)


class PreparedTests(unittest.TestCase):
    def fixture(self, root):
        resources = tuple(resource for _, _, group in PREPARED.SCENES.values() for resource in group)
        with patch.object(FIXTURE.PILOT, "OCCLUDERS", resources), patch.object(FIXTURE.PILOT, "PROPS", ()):
            room2, catalog, _, _ = FIXTURE.PilotTests().fixture(root)
        data = root / "data"
        data.mkdir()
        room2.rename(data / "room2-hd")
        room2 = data / "room2-hd"
        base = room2 / "baselines-v1"
        manifest = json.loads((base / "manifest.json").read_text())
        runtime = json.loads((room2 / "runtime-map-v1.json").read_text())
        room1 = data / "room1-hd/work-v1"
        (room1 / "inputs").mkdir(parents=True)
        first = PREPARED.SCENES["Scene1001"][2]
        jobs, entries = [], []
        for case in manifest["cases"]:
            if case["resource"] not in first:
                continue
            frame = case["frames"][0]
            job = next(job for job in manifest["jobs"] if job["id"] == frame["job"])
            jobs.append(job)
            (room1 / job["file"]).write_bytes((base / job["file"]).read_bytes())
            entry = next(entry.copy() for entry in runtime["entries"] if entry["resource"] == case["resource"])
            entry.update(kind="layer", frame=0, job=job["id"], metadata=frame["metadata"],
                         sourceIndexedSHA256=frame["sourceIndexedSHA256"],
                         surfaceSize=frame["rasterVariants"][0]["surfaceSize"])
            entries.append(entry)
        background_path = room1 / "inputs/background.png"
        background_path.write_bytes((base / "original-background.png").read_bytes())
        jobs.append({"id": "background", "resource": "4086520e", "frame": 0, "opaque": True,
                     "file": "inputs/background.png", "sha256": FIXTURE.encoded_hash(background_path), "size": [640, 480]})
        room1_manifest = {"room": "Scene1001", "scale": 4, "sourceBinding": "synthetic",
                          "paletteSHA256": manifest["paletteSHA256"], "paletteCRC32": runtime["paletteCRC32"],
                          "jobs": jobs, "entries": entries}
        (room1 / "manifest.json").write_text(json.dumps(room1_manifest))
        manifest["cases"] = [case for case in manifest["cases"] if case["resource"] not in first]
        manifest["jobs"] = [job for job in manifest["jobs"] if job["resource"] not in first]
        (base / "manifest.json").write_text(json.dumps(manifest))
        runtime["entries"] = [entry for entry in runtime["entries"] if entry["resource"] not in first]
        runtime["sourceManifestSHA256"] = FIXTURE.encoded_hash(base / "manifest.json")
        (room2 / "runtime-map-v1.json").write_text(json.dumps(runtime))
        with sqlite3.connect(catalog / "catalog.sqlite") as db:
            db.execute("INSERT INTO aliases VALUES(?,?)", (int("4086520e", 16), "background"))
            db.execute("INSERT INTO decodedframes SELECT 'room1-background',indexed_blob,width,height,?,metadata_json "
                       "FROM decodedframes WHERE id='background'", (int("4086520e", 16),))
        engine = root / "scummvm/engines/neverhood/modules"
        engine.mkdir(parents=True)
        for name in ("module1000.cpp", "module1000_sprites.cpp"):
            (engine / name).write_text("// Synthetic evidence input; not engine implementation.\n")
        return data, catalog

    def build(self, root, data, catalog):
        return PREPARED.build_prepared_catalog(root, data, catalog)

    def test_thirteen_bindings_read_only_and_state_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, catalog = self.fixture(root)
            before = {p: FIXTURE.encoded_hash(p) for p in root.rglob("*") if p.is_file()}
            result = self.build(root, data, catalog)
            self.assertEqual(result["schemaVersion"], 1)
            self.assertEqual(len(result["assets"]), 13)
            self.assertEqual(sum(item["processingStatus"] == "eligible" for item in result["assets"]), 12)
            self.assertEqual(len({item["id"] for item in result["assets"]}), 13)
            by_resource = {item["resource"]: item for item in result["assets"]}
            button = by_resource["15288120"]
            self.assertEqual(button["blockedReasons"], ["missing-restored-state-RGB"])
            self.assertEqual(button["stateRules"]["visibleTicks"], 8)
            self.assertNotIn("backgroundCorrespondence", button["asset"])
            self.assertEqual(by_resource["8c066150"]["stateRules"]["condition"], {"V_WINDOW_OPEN": False})
            self.assertEqual(by_resource["316c4bb4"]["kind"], "foreground-occluder")
            self.assertEqual(by_resource["06149428"]["kind"], "static-prop")
            for item in result["assets"]:
                self.assertEqual(item["bindingStatus"], "verified")
                self.assertEqual(item["asset"]["sourceIdentity"]["stateRules"], item["stateRules"])
                self.assertIn("sourceOriginalBackgroundVisibleRGB", item)
                self.assertFalse(item["runtimePromotion"])
            self.assertEqual(result, self.build(root, data, catalog))
            self.assertEqual(before, {p: FIXTURE.encoded_hash(p) for p in root.rglob("*") if p.is_file()})

    def test_tampered_identity_is_rejected(self):
        mutations = ("palette", "palette-association", "blob", "raster", "runtime-key", "source",
                     "metadata", "frame", "background", "background-pixels", "binding", "manifest", "path")
        for mutation in mutations:
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                data, catalog = self.fixture(root)
                path = data / "room1-hd/work-v1/manifest.json"
                manifest = json.loads(path.read_text())
                if mutation == "palette":
                    manifest["paletteCRC32"] = "00000000"
                elif mutation == "palette-association":
                    with sqlite3.connect(catalog / "catalog.sqlite") as db:
                        db.execute("UPDATE palettes SET blob=?", ("0" * 64,))
                elif mutation == "blob":
                    (catalog / "blobs" / manifest["entries"][0]["sourceIndexedSHA256"]).write_bytes(b"corrupt")
                elif mutation == "raster":
                    manifest["entries"][0]["sourceSHA256"] = "0" * 64
                elif mutation == "runtime-key":
                    manifest["entries"][0]["key"] += "-wrong"
                elif mutation == "source":
                    source = path.parent / manifest["jobs"][0]["file"]
                    with FIXTURE.Image.open(source) as image:
                        changed = image.copy()
                    changed.putpixel((0, 0), (255, 0, 0, 255))
                    changed.save(source)
                    manifest["jobs"][0]["sha256"] = FIXTURE.encoded_hash(source)
                elif mutation == "metadata":
                    manifest["entries"][0]["metadata"]["x"] += 1
                elif mutation == "frame":
                    manifest["entries"][0]["frame"] = 1
                elif mutation == "background":
                    manifest["jobs"][-1]["sha256"] = "0" * 64
                elif mutation == "background-pixels":
                    source = path.parent / manifest["jobs"][-1]["file"]
                    with FIXTURE.Image.open(source) as image:
                        changed = image.copy()
                    changed.putpixel((0, 0), (255, 0, 0))
                    changed.save(source)
                    manifest["jobs"][-1]["sha256"] = FIXTURE.encoded_hash(source)
                elif mutation == "binding":
                    manifest["sourceBinding"] = "wrong"
                elif mutation == "path":
                    manifest["jobs"][0]["file"] = "../../../../outside.png"
                else:
                    runtime_path = data / "room2-hd/runtime-map-v1.json"
                    runtime = json.loads(runtime_path.read_text())
                    runtime["sourceManifestSHA256"] = "0" * 64
                    runtime_path.write_text(json.dumps(runtime))
                path.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    self.build(root, data, catalog)

    def test_context_id_includes_state_and_input_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, catalog = self.fixture(root)
            before = self.build(root, data, catalog)
            original = PREPARED.state_rules
            def changed(scene, resource):
                rules = original(scene, resource)
                rules["additionalReviewConstraint"] = True
                return rules
            with patch.object(PREPARED, "state_rules", changed):
                after = self.build(root, data, catalog)
            self.assertNotEqual(before["assets"][0]["id"], after["assets"][0]["id"])
            path = data / "room1-hd/work-v1/manifest.json"
            path.write_text(path.read_text() + "\n")
            after = self.build(root, data, catalog)
            self.assertNotEqual(before["assets"][0]["id"], after["assets"][0]["id"])


if __name__ == "__main__":
    unittest.main()
