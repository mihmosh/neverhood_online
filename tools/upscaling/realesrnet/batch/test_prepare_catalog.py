import hashlib
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
import zipfile

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_contract import MODEL_SHA256, NAMESPACE, PREPROC_SPEC, job_key, keyset_digest

spec = importlib.util.spec_from_file_location("prepare_catalog", Path(__file__).with_name("prepare-catalog.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def fixture(root):
    (root / "blobs").mkdir()
    db = sqlite3.connect(root / "catalog.sqlite")
    db.executescript("""
        CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,size INTEGER,path TEXT);
        CREATE TABLE archives(id TEXT PRIMARY KEY,load_order INTEGER);
        CREATE TABLE resources(id TEXT PRIMARY KEY,archive_id TEXT,hash INTEGER,type INTEGER,status TEXT,timestamp INTEGER,entry_index INTEGER,raw_blob TEXT,payload_blob TEXT);
        CREATE TABLE palettes(id TEXT PRIMARY KEY,blob TEXT,association TEXT);
        CREATE TABLE decodedframes(id TEXT PRIMARY KEY,resource_id TEXT,palette_id TEXT,width INTEGER,height INTEGER,indexed_blob TEXT,png_blob TEXT,list_index INTEGER,metadata_json TEXT);
        CREATE TABLE aliases(id TEXT PRIMARY KEY,chain_json TEXT);
        CREATE TABLE logicalframes(id TEXT PRIMARY KEY,decoded_frame_id TEXT);
        CREATE TABLE raster_variants(id TEXT PRIMARY KEY,recipe_json TEXT);
        CREATE TABLE frame_associations(id TEXT PRIMARY KEY,metadata_json TEXT);
        INSERT INTO archives VALUES('a',0);
        INSERT INTO aliases VALUES('alias','["old","new"]');
        INSERT INTO logicalframes VALUES('logical','f0');
        INSERT INTO raster_variants VALUES('flip','{"flipX":true}');
        INSERT INTO frame_associations VALUES('context','{ "palette" : "runtime-unverified" }');
    """)

    def blob(data):
        digest = hashlib.sha256(data).hexdigest()
        relative = "blobs/" + digest + ".bin"
        (root / relative).write_bytes(data)
        db.execute("INSERT OR IGNORE INTO blobs VALUES(?,?,?)", (digest,len(data),relative))
        return digest

    payload = blob(b"original-resource")
    for resource, timestamp in (("old",1),("new",2)):
        db.execute("INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?)", (resource,"a",123,4,"decoded",timestamp,timestamp,payload,payload))
    db.execute("INSERT INTO resources VALUES('bitmap','a',456,2,'decoded',1,3,NULL,NULL)")
    db.execute("INSERT INTO resources VALUES('video','a',789,10,'payload-exported',1,4,NULL,NULL)")
    palette = bytearray(1024)
    palette[0:4] = bytes([77,88,99,255])
    palette[256:260] = bytes([10,20,30,0])
    for p, unused in (("p0",1),("p1",2)):
        palette[4] = unused
        digest = blob(bytes(palette))
        db.execute("INSERT INTO palettes VALUES(?,?,?)", (p,digest,"embedded"))
    for i, indices in enumerate((b"\0\x40", b"\0\x40", b"\x40\0")):
        db.execute("INSERT INTO decodedframes VALUES(?,?,?,?,?,?,?,?,?)", (f"f{i}","old" if i == 0 else "new","p0" if i == 0 else "p1",2,1,blob(indices),None,7,'{ "durationTicks" : 2, "x": -7 }'))
    db.commit()
    db.close()


class PreparationTests(unittest.TestCase):
    def test_hash_contract_exact(self):
        rgba = bytes([1,2,3,255,0,0,0,0])
        expected = hashlib.sha256(NAMESPACE + MODEL_SHA256.encode() + b"\0" + PREPROC_SPEC.encode() + b"\0" + struct.pack("<II",2,1) + rgba).hexdigest()
        self.assertEqual(job_key(2,1,rgba),expected)
        self.assertNotEqual(job_key(1,2,rgba),expected)
        self.assertEqual(keyset_digest(["b","a","a"]),hashlib.sha256(b"a\nb\n").hexdigest())
        with self.assertRaises(ValueError):
            job_key(2,1,b"short")

    def test_index0_only_and_hidden_rgb(self):
        palette = bytes([100,101,102,0]) * 256
        rgba = prepare.rgba_from_indexed(bytes([0,64,1]),palette,3,1)
        self.assertEqual(rgba,bytes([0,0,0,0,100,101,102,255,100,101,102,255]))
        with self.assertRaises(ValueError):
            prepare.rgba_from_indexed(b"\0",palette,2,1)

    def test_full_export_preserves_metadata_and_refs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            before = prepare.sha((root / "catalog.sqlite").read_bytes())
            output = root / "out"
            summary = prepare.prepare(root,output)
            self.assertEqual(summary["physicalFrames"],3)
            self.assertEqual(summary["sourceUniqueJobs"],2)
            self.assertEqual(summary["duplicates"],1)
            self.assertEqual(summary["winnerFrames"],2)
            self.assertEqual(summary["supersededFrames"],1)
            self.assertEqual(summary["processedGPUJobs"],0)
            self.assertEqual(before,prepare.sha((root / "catalog.sqlite").read_bytes()))
            with closing(sqlite3.connect(output / "jobs.sqlite")) as db:
                self.assertEqual(db.execute("SELECT metadata_json FROM decodedframes WHERE id='f0'").fetchone()[0],'{ "durationTicks" : 2, "x": -7 }')
                for table in ("aliases","logicalframes","raster_variants","frame_associations"):
                    self.assertEqual(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0],1)
                self.assertEqual(db.execute("SELECT retain_flag FROM frame_jobs WHERE frame_id='f0'").fetchone()[0],0)
                self.assertEqual(db.execute("SELECT original_list_id FROM frame_jobs WHERE frame_id='f0'").fetchone()[0],7)
                keys = [r[0] for r in db.execute("SELECT job_key FROM jobs")]
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertTrue(manifest["localOnly"])
            found = []
            for pack in manifest["packs"]:
                data = (output / pack["file"]).read_bytes()
                self.assertEqual(prepare.sha(data),pack["sha256"])
                with zipfile.ZipFile(output / pack["file"]) as z:
                    for info in z.infolist():
                        self.assertEqual(info.compress_type,zipfile.ZIP_STORED)
                        self.assertRegex(info.filename,r"^[0-9a-f]{64}\.png$")
                        found.append(info.filename[:-4])
                        with Image.open(z.open(info)) as image:
                            self.assertEqual(image.mode,"RGBA")
                            self.assertEqual(set(image.getchannel("A").getdata()),{0,255})
            self.assertEqual(sorted(found),sorted(keys))
            self.assertEqual(summary["keysetSHA256"],keyset_digest(found))
            with self.assertRaisesRegex(ValueError,"already exists"):
                prepare.prepare(root,output)

    def test_pack_exact_limit_and_split(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "input.png"
            source.write_bytes(b"x" * 100)
            limit = 22 + 100 + 30 + 46 + 2*68
            packs = prepare.pack_inputs([("a"*64,source),("b"*64,source)],root,max_bytes=limit)
            self.assertEqual(len(packs),2)
            self.assertTrue(all(p["bytes"] == limit for p in packs))

    def test_blob_corruption_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            with closing(sqlite3.connect(root / "catalog.sqlite")) as db:
                path = db.execute("SELECT path FROM blobs LIMIT 1").fetchone()[0]
            (root / path).write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError,"mismatch"):
                prepare.prepare(root,root / "out")

    def test_blob_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            with closing(sqlite3.connect(root / "catalog.sqlite")) as db, db:
                db.execute("UPDATE blobs SET path='../outside'")
            with self.assertRaisesRegex(ValueError,"escapes"):
                prepare.prepare(root,root / "out")

    def test_missing_palette_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            with closing(sqlite3.connect(root / "catalog.sqlite")) as db, db:
                db.execute("DELETE FROM palettes WHERE id='p0'")
            with self.assertRaisesRegex(ValueError,"missing embedded"):
                prepare.prepare(root,root / "out")
            self.assertFalse((root / "out").exists())

    def test_all_transparent_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture(root)
            data = b"\0\0"
            digest = prepare.sha(data)
            relative = f"blobs/{digest}.bin"
            (root / relative).write_bytes(data)
            with closing(sqlite3.connect(root / "catalog.sqlite")) as db, db:
                db.execute("INSERT INTO blobs VALUES(?,?,?)",(digest,2,relative))
                db.execute("UPDATE decodedframes SET indexed_blob=?",(digest,))
            summary = prepare.prepare(root,root / "out")
            self.assertEqual(summary["fullyTransparentJobs"],1)
            self.assertEqual(summary["sourceUniqueJobs"],1)

    def test_actual_export_integrity_when_present(self):
        root = Path(__file__).resolve().parents[4] / "private-assets"
        output = root / "upscaling/full-game-v1"
        if not (output / "manifest.json").exists():
            self.skipTest("Actual private export not present")
        manifest = json.loads((output / "manifest.json").read_text())
        with closing(sqlite3.connect((root / "catalog.sqlite").as_uri() + "?mode=ro",uri=True)) as source, closing(sqlite3.connect((output / "jobs.sqlite").as_uri() + "?mode=ro",uri=True)) as db:
            db.row_factory = sqlite3.Row
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0],"ok")
            tables = [r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for table in tables:
                original = list(source.execute(f'SELECT * FROM "{table}" ORDER BY rowid'))
                copied = [tuple(r) for r in db.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
                self.assertEqual(copied,original,table)
            jobs = {r["job_key"]:r for r in db.execute("SELECT * FROM jobs")}
            seen = set()
            for pack in manifest["packs"]:
                path = output / pack["file"]
                self.assertEqual(path.stat().st_size,pack["bytes"])
                self.assertLessEqual(path.stat().st_size,32*1024*1024)
                self.assertEqual(prepare.sha(path.read_bytes()),pack["sha256"])
                with zipfile.ZipFile(path) as archive:
                    self.assertIsNone(archive.testzip())
                    self.assertEqual(len(archive.infolist()),pack["count"])
                    self.assertEqual(archive.namelist(),[key+".png" for key in pack["jobKeys"]])
                    for info in archive.infolist():
                        self.assertRegex(info.filename,r"^[0-9a-f]{64}\.png$")
                        key = info.filename[:-4]
                        self.assertNotIn(key,seen)
                        seen.add(key)
                        self.assertEqual(info.compress_type,zipfile.ZIP_STORED)
                        data = archive.read(info)
                        self.assertEqual(prepare.sha(data),jobs[key]["input_sha256"])
                        self.assertEqual(data,(output / jobs[key]["input_path"]).read_bytes())
                        with Image.open(archive.open(info)) as image:
                            self.assertEqual(image.mode,"RGBA")
                            rgba = image.tobytes()
                            self.assertTrue(set(rgba[3::4]).issubset({0,255}))
                            self.assertEqual(job_key(*image.size,rgba),key)
                            self.assertEqual(prepare.sha(rgba),jobs[key]["rgba_sha256"])
            self.assertEqual(seen,set(jobs))
            self.assertEqual(keyset_digest(seen),manifest["summary"]["keysetSHA256"])
            self.assertEqual(db.execute("SELECT count(*) FROM frame_jobs").fetchone()[0],6813)
            self.assertEqual(db.execute("SELECT count(*) FROM frame_jobs WHERE retain_flag=0").fetchone()[0],20)


if __name__ == "__main__":
    unittest.main()
