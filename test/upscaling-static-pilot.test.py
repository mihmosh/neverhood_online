import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
import zlib

import numpy as np
from PIL import Image

DIRECTORY = Path(__file__).resolve().parents[1] / "tools/upscaling/static"
sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location("static_pilot", DIRECTORY / "pilot.py")
PILOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PILOT)


def encoded_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PilotTests(unittest.TestCase):
    def fixture(self, root):
        prepared = root / "prepared"
        base = prepared / "baselines-v1"
        catalog = root / "catalog"
        for folder in (base / "inputs", base / "neural", base / "origins", prepared / "pack-v1/images", prepared / "pack-v1/backgrounds", catalog / "blobs"):
            folder.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(catalog / "catalog.sqlite")
        db.execute("CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,path TEXT,size INTEGER)")
        db.execute("CREATE TABLE decodedframes(id TEXT PRIMARY KEY,indexed_blob TEXT,width INTEGER,height INTEGER,requested_hash INTEGER,metadata_json TEXT)")
        db.execute("CREATE TABLE palettes(resource_id TEXT,blob TEXT)")
        db.execute("CREATE TABLE aliases(requested_hash INTEGER,resolved_id TEXT)")

        def store(data):
            identity = hashlib.sha256(data).hexdigest()
            path = catalog / "blobs" / identity
            path.write_bytes(data)
            db.execute("INSERT OR IGNORE INTO blobs VALUES(?,?,?)", (identity, "blobs/" + identity, len(data)))
            return identity

        palette = np.zeros((256, 4), np.uint8)
        palette[:, 0] = np.arange(256, dtype=np.uint8)
        palette[:, 1] = 100
        palette[:, 2] = 200
        palette[:, 3] = 255
        palette_bytes = palette.tobytes()
        palette_hash = store(palette_bytes)
        db.execute("INSERT INTO palettes VALUES(?,?)", ("background", palette_hash))
        db.execute("INSERT INTO aliases VALUES(?,?)", (int("12c23307", 16), "background"))
        jobs, cases, entries = [], [], []
        background_indices = np.zeros((480, 640), np.uint8)
        for i, resource in enumerate((*PILOT.OCCLUDERS, *PILOT.PROPS)):
            width, height, x, y = 3 + i % 2, 4 + i, 10 + i * 20, 20 + i * 10
            indices = np.full((height, width), i + 1, np.uint8)
            indices[1, 1] = 0
            rgba = np.empty((height, width, 4), np.uint8)
            rgba[:, :, :3] = palette[indices, :3]
            rgba[:, :, 3] = np.where(indices == 0, 0, 255)
            background_indices[y:y + height, x:x + width] = indices
            indexed_hash = store(indices.tobytes())
            metadata = {"flags": 23, "width": width, "height": height, "x": x, "y": y}
            frame_id = resource + ":list:0:frame:0"
            db.execute("INSERT INTO decodedframes VALUES(?,?,?,?,?,?)", (frame_id, indexed_hash, width, height, int(resource, 16), json.dumps(metadata)))
            job_id = "job-" + resource
            source_path = base / "inputs" / (job_id + ".png")
            Image.fromarray(rgba).save(source_path)
            job = {"id": job_id, "file": "inputs/" + source_path.name, "sha256": encoded_hash(source_path), "size": [width, height], "resource": resource, "frame": 0}
            jobs.append(job)
            padded = np.zeros((height, 4), np.uint8)
            padded[:, :width] = indices
            padded_hash = hashlib.sha256(padded.tobytes()).hexdigest()
            frame = {"index": 0, "frameId": frame_id, "job": job_id, "sourceIndexedSHA256": indexed_hash, "metadata": metadata,
                     "rasterVariants": [{"flipX": False, "surfaceSize": [4, height], "indexedSHA256": padded_hash}]}
            cases.append({"resource": resource, "remove64": False, "actor": "static", "capacity": [width, height], "frames": [frame]})
            predicted = Image.fromarray(rgba).resize((width * 4, height * 4), Image.Resampling.NEAREST)
            pixels = np.asarray(predicted).copy()
            pixels[0, 0, 3] = 128
            predicted = Image.fromarray(pixels)
            donor = base / "neural" / (job_id + ".png")
            predicted.save(donor)
            (base / "origins" / (job_id + ".json")).write_text(json.dumps({"inputSHA256": job["sha256"], "outputSHA256": encoded_hash(donor), "model": {"name": "synthetic donor, no inference"}}))
            packed = Image.new("RGBA", (16, height * 4))
            packed.paste(predicted, (0, 0))
            packed_path = prepared / "pack-v1/images" / (resource + ".png")
            packed.save(packed_path)
            key = f"4x{height}-4-{zlib.crc32(padded.tobytes()):08x}-p{zlib.crc32(palette_bytes):08x}-0"
            entries.append({"resource": resource, "frameId": frame_id, "sourceSHA256": padded_hash,
                            "width": 16, "height": height * 4, "nativeSize": [width, height], "key": key,
                            "flipX": False, "file": "images/" + packed_path.name, "crop": {"x": 0, "y": 0, "width": width * 4, "height": height * 4}})
        background_blob = store(background_indices.tobytes())
        db.execute("INSERT INTO decodedframes VALUES(?,?,?,?,?,?)", ("background", background_blob, 640, 480, int("12c23307", 16), "{}"))
        original = Image.fromarray(palette[background_indices, :3])
        original.save(base / "original-background.png")
        original.resize((2560, 1920), Image.Resampling.NEAREST).save(prepared / "pack-v1/backgrounds/gemini.png")
        nano = root / "nano.png"
        original.resize((2400, 1792), Image.Resampling.NEAREST).save(nano)
        nano_result = root / "nano-result.json"
        nano_result.write_text(json.dumps({"status": "succeeded", "images": [{"path": str(nano), "sha256": encoded_hash(nano), "thought": False}]}))
        manifest = {"scene": "Scene1002", "paletteResource": "12c23307", "paletteSHA256": palette_hash, "jobs": jobs, "cases": cases}
        manifest_path = base / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        runtime = {"room": "Scene1002", "scale": 4, "sourceBinding": "synthetic", "sourceManifestSHA256": encoded_hash(manifest_path),
                   "paletteCRC32": f"{zlib.crc32(palette_bytes):08x}", "entries": entries}
        (prepared / "runtime-map-v1.json").write_text(json.dumps(runtime))
        (catalog / "manifest.json").write_text(json.dumps({"sourceBinding": "synthetic"}))
        db.commit()
        db.close()
        return prepared, catalog, root / "output", nano_result

    def test_twelve_candidates_and_immutable_repeat(self):
        with tempfile.TemporaryDirectory() as directory:
            args = self.fixture(Path(directory))
            record = PILOT.run(*args)
            self.assertEqual(len(record["candidates"]), 12)
            self.assertEqual(record["inferenceRequests"], 0)
            self.assertFalse(record["runtimePromotion"])
            for item in record["candidates"]:
                self.assertTrue(item["candidateAlpha"]["exactEquality"])
                self.assertEqual(item["candidateAlpha"]["candidate"]["softCount"], 0)
            before = encoded_hash(args[2] / "manifest.json")
            self.assertEqual(PILOT.run(*args), record)
            self.assertEqual(encoded_hash(args[2] / "manifest.json"), before)
            page = (args[2] / "report.html").read_text()
            self.assertIn('lang="en"', page)
            self.assertIn("Candidate on white", page)
            self.assertNotIn("accepted for gameplay", page)

    def test_palette_or_placement_tampering_is_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            prepared, catalog, output, nano = self.fixture(Path(directory))
            runtime_path = prepared / "runtime-map-v1.json"
            runtime = json.loads(runtime_path.read_text())
            runtime["entries"][0]["key"] = runtime["entries"][0]["key"].replace("-0", "-1")
            runtime_path.write_text(json.dumps(runtime))
            with self.assertRaisesRegex(ValueError, "Runtime palette, transparency"):
                PILOT.run(prepared, catalog, output, nano)


if __name__ == "__main__":
    unittest.main()
