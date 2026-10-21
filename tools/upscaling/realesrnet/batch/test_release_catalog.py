import importlib.util
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_contract import job_key, keyset_digest

spec = importlib.util.spec_from_file_location("release_catalog", Path(__file__).with_name("release-catalog.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def fixture(root):
    batch = root / "batch"
    batch.mkdir()
    for folder in ("inputs", "outputs"):
        (batch / folder).mkdir()
    (root / "blobs").mkdir()
    db = sqlite3.connect(batch / "jobs.sqlite")
    db.executescript("""
        CREATE TABLE archives(id TEXT,name TEXT,sha256 TEXT,load_order INTEGER);
        CREATE TABLE resources(id TEXT,archive_id TEXT,hash INTEGER,type INTEGER,timestamp INTEGER,entry_index INTEGER,payload_blob TEXT);
        CREATE TABLE blobs(sha256 TEXT,size INTEGER,path TEXT);
        CREATE TABLE palettes(id TEXT,resource_id TEXT,blob TEXT,association TEXT);
        CREATE TABLE decodedframes(id TEXT,resource_id TEXT,requested_hash INTEGER,resolved_hash INTEGER,list_index INTEGER,
            frame_index INTEGER,width INTEGER,height INTEGER,indexed_blob TEXT,palette_id TEXT,metadata_json TEXT);
        CREATE TABLE frame_jobs(frame_id TEXT,job_key TEXT,is_winner INTEGER,retain_flag INTEGER,original_list_id INTEGER);
        CREATE TABLE jobs(job_key TEXT,width INTEGER,height INTEGER,input_path TEXT,input_sha256 TEXT,input_bytes INTEGER,rgba_sha256 TEXT);
        CREATE TABLE aliases(requested_id TEXT,requested_hash INTEGER,resolved_id TEXT,status TEXT,chain_json TEXT);
        CREATE TABLE hd_outputs(job_key TEXT,sha256 TEXT,bytes INTEGER);
        INSERT INTO archives VALUES('a','s.blb','container-hash',0);
    """)

    def blob(data):
        digest = release.sha(data)
        relative = "blobs/" + digest
        (root / relative).write_bytes(data)
        db.execute("INSERT INTO blobs VALUES(?,?,?)", (digest, len(data), relative))
        return digest

    # Two aliases select different ranges; the second range overlaps the first.
    payload = bytearray(28 + 3 * 32)
    struct.pack_into("<HHII", payload, 0, 2, 28, len(payload), 0)
    struct.pack_into("<IHH", payload, 12, 100, 2, 0)
    struct.pack_into("<IHH", payload, 20, 200, 2, 32)
    for index in range(3):
        struct.pack_into("<IHhhHH", payload, 28 + index * 32, 0, index + 2, -3, 4, 2, 1)
    payload_hash = blob(bytes(payload))
    for identifier, resource_hash, timestamp, entry in (("old", 100, 1, 0), ("new", 100, 2, 1), ("alias", 200, 1, 2)):
        db.execute("INSERT INTO resources VALUES(?,?,?,?,?,?,?)", (identifier, "a", resource_hash, 4, timestamp, entry, payload_hash))
    db.execute("INSERT INTO aliases VALUES('new',100,'new','resolved','[\"new\"]')")
    db.execute("INSERT INTO aliases VALUES('alias',200,'new','resolved','[\"alias\",\"new\"]')")
    palette = bytes([91, 83, 72, 19, 10, 20, 30, 0]) + bytes(1016)
    palette_hash = blob(palette)
    indexed_hash = blob(b"\0\1")
    for identifier in ("old", "new"):
        db.execute("INSERT INTO palettes VALUES(?,?,?,?)", (identifier + "-pal", identifier, palette_hash, "embedded"))
    rgba = bytes([0, 0, 0, 0, 10, 20, 30, 255])
    key = job_key(2, 1, rgba)
    Image.frombytes("RGBA", (2, 1), rgba).save(batch / "inputs" / (key + ".png"))
    Image.frombytes("RGBA", (2, 1), rgba).resize((8, 4), Image.Resampling.NEAREST).save(batch / "outputs" / (key + ".png"))
    source = (batch / "inputs" / (key + ".png")).read_bytes()
    output = (batch / "outputs" / (key + ".png")).read_bytes()
    db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)", (key, 2, 1, "inputs/" + key + ".png", release.sha(source), len(source), release.sha(rgba)))
    db.execute("INSERT INTO hd_outputs VALUES(?,?,?)", (key, release.sha(output), len(output)))
    records = []
    for resource, list_index, requested, index in (("old", 0, 100, 0), ("new", 0, 100, 0), ("new", 0, 100, 1), ("new", 1, 200, 0), ("new", 1, 200, 1)):
        identifier = f"{resource}-{list_index}-{index}"
        metadata = {"durationTicks": index + list_index + 2, "x": -3, "y": 4,
                    "frameHash": 0, "width": 2, "height": 1}
        db.execute("INSERT INTO decodedframes VALUES(?,?,?,?,?,?,?,?,?,?,?)", (identifier, resource, requested, 100, list_index, index, 2, 1, indexed_hash, resource + "-pal", json.dumps(metadata)))
        db.execute("INSERT INTO frame_jobs VALUES(?,?,?,?,?)", (identifier, key, int(resource == "new"), int(resource == "new"), list_index))
        records.append({"source_frame_id": identifier, "job_key": key, "width": 2, "height": 1,
                        "list_index": list_index, "frame_index": index, "original_list_id": list_index,
                        "is_winner": int(resource == "new"), "retain_flag": int(resource == "new"),
                        "metadata": metadata, "scale": 4, "output_sha256": release.sha(output), "output_bytes": len(output)})
    db.commit()
    db.close()
    (batch / "hd-animation-assets.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    (batch / "manifest.json").write_text(json.dumps({"sourcePrivateRoot": str(root), "database": "jobs.sqlite", "model": {"scale": 4},
        "summary": {"sourceUniqueJobs": 1, "physicalFrames": 5, "winnerFrames": 4, "supersededFrames": 1, "keysetSHA256": keyset_digest([key])}}))
    return batch, key


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.batch, self.key = fixture(self.root)

    def test_alias_range_mapping_provenance_and_exclusion(self):
        result = release.build_catalog(self.batch)
        self.assertTrue(result["validation"]["valid"])
        self.assertEqual(result["validation"]["supersededFrames"], 1)
        self.assertEqual(len(result["resources"]), 1)
        plan = result["resources"][0]
        mappings = plan["runtimeMappings"]
        self.assertEqual([(m["requestedHash"], m["frameIndex"], m["physicalOrdinal"]) for m in mappings],
                         [(200, 0, 2), (200, 1, 3), (100, 0, 0), (100, 1, 1)])
        self.assertTrue(all(m["resolvedHash"] == 100 for m in mappings))
        self.assertEqual(mappings[0]["aliasChain"], ["alias", "new"])
        frames = plan["frames"]
        self.assertEqual(frames[1]["frameInfoOffset"], frames[2]["frameInfoOffset"])
        self.assertEqual([f["metadata"]["durationTicks"] for f in frames], [2, 3, 3, 4])
        palette = frames[0]["source"]["palette"]
        self.assertEqual(bytes.fromhex(palette["bytesHex"])[:4], bytes([91, 83, 72, 19]))
        indexed = frames[0]["source"]["indexedRaster"]
        self.assertEqual(Path(indexed["path"]).read_bytes(), b"\0\1")
        self.assertEqual(len(plan["members"]), 1)
        self.assertFalse(plan["archive"]["reencode"])
        self.assertEqual(result["excludedFrames"][0]["metadata"]["durationTicks"], 2)

    def test_missing_is_not_valid(self):
        (self.batch / "outputs" / (self.key + ".png")).unlink()
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        self.assertEqual(result["validation"]["missingImages"], [self.key])
        self.assertEqual(result["validation"]["verifiedImages"], 0)

    def test_corrupt_output_hash(self):
        (self.batch / "outputs" / (self.key + ".png")).write_bytes(b"not-png")
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        self.assertIn("hash/size", result["validation"]["invalidImages"][0]["reason"])

    def change_output(self, image):
        path = self.batch / "outputs" / (self.key + ".png")
        image.save(path)
        data = path.read_bytes()
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            db.execute("UPDATE hd_outputs SET sha256=?,bytes=?", (release.sha(data), len(data)))
        records = [json.loads(line) for line in (self.batch / "hd-animation-assets.jsonl").read_text().splitlines()]
        for record in records:
            record.update(output_sha256=release.sha(data), output_bytes=len(data))
        (self.batch / "hd-animation-assets.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))

    def test_saved_hash_does_not_replace_dimension_or_pixel_validation(self):
        self.change_output(Image.new("RGBA", (4, 4)))
        result = release.build_catalog(self.batch)
        self.assertIn("dimensions", result["validation"]["invalidImages"][0]["reason"])
        self.change_output(Image.new("RGBA", (8, 4), (1, 2, 3, 255)))
        result = release.build_catalog(self.batch)
        self.assertIn("alpha mask", result["validation"]["invalidImages"][0]["reason"])

    def test_missing_authoritative_raster_explicit_unknown(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            digest = db.execute("SELECT indexed_blob FROM decodedframes LIMIT 1").fetchone()[0]
        (self.root / "blobs" / digest).unlink()
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        source = result["resources"][0]["frames"][0]["source"]
        self.assertEqual(source["status"], "unknown")
        self.assertIsNone(source["palette"])
        self.assertIsNone(source["indexedRaster"])

    def test_source_tampering_and_path_escape_rejected(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            db.execute("UPDATE jobs SET input_path='../escape.png'")
        with self.assertRaisesRegex(ValueError, "escapes"):
            release.build_catalog(self.batch)

    def test_saved_record_conflict_rejected(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            db.execute("UPDATE hd_outputs SET sha256='wrong'")
        with self.assertRaisesRegex(ValueError, "database/JSONL"):
            release.build_catalog(self.batch)

    def test_unbound_output_is_not_verified(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            db.execute("DELETE FROM hd_outputs")
        records = [json.loads(line) for line in (self.batch / "hd-animation-assets.jsonl").read_text().splitlines()]
        for record in records:
            record.pop("output_sha256")
            record.pop("output_bytes")
        (self.batch / "hd-animation-assets.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        self.assertEqual(result["validation"]["unboundImages"], [self.key])
        self.assertEqual(result["images"][0]["validation"], "contents-only-unbound")

    def test_unknown_payload_prevents_mapping_not_pixel_validation(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            digest = db.execute("SELECT payload_blob FROM resources LIMIT 1").fetchone()[0]
        (self.root / "blobs" / digest).unlink()
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        self.assertEqual(result["validation"]["verifiedImages"], 1)
        self.assertEqual(result["validation"]["runtimeMappings"], 0)
        self.assertEqual(len(result["validation"]["mappingIssues"]), 1)

    def test_authoritative_blob_corruption_is_not_unknown(self):
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            digest = db.execute("SELECT indexed_blob FROM decodedframes LIMIT 1").fetchone()[0]
        (self.root / "blobs" / digest).write_bytes(b"\1\0")
        with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
            release.build_catalog(self.batch)

    def test_unexpected_png_prevents_complete_validation(self):
        (self.batch / "outputs" / "unexpected.png").write_bytes(b"unexpected")
        result = release.build_catalog(self.batch)
        self.assertFalse(result["validation"]["valid"])
        self.assertEqual(result["validation"]["unexpectedImages"], ["outputs/unexpected.png"])

    def test_parser_bounds_and_first_matching_list(self):
        with self.assertRaisesRegex(ValueError, "Truncated"):
            release.animation_lists(bytes(10))
        with sqlite3.connect(self.batch / "jobs.sqlite") as db:
            digest = db.execute("SELECT payload_blob FROM resources LIMIT 1").fetchone()[0]
            data = bytearray((self.root / "blobs" / digest).read_bytes())
            struct.pack_into("<I", data, 20, 100)
            new = release.sha(data)
            (self.root / "blobs" / new).write_bytes(data)
            db.execute("INSERT INTO blobs VALUES(?,?,?)", (new, len(data), "blobs/" + new))
            db.execute("UPDATE resources SET payload_blob=?", (new,))
            db.execute("UPDATE decodedframes SET requested_hash=100 WHERE list_index=1")
        result = release.build_catalog(self.batch)
        mappings = result["resources"][0]["runtimeMappings"]
        self.assertEqual([m["physicalOrdinal"] for m in mappings], [0, 1])
        self.assertTrue(result["validation"]["valid"])
        self.assertEqual(result["validation"]["unloadableRequests"], 1)
        self.assertIn("no-matching-internal-animation", result["unloadableRequests"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
