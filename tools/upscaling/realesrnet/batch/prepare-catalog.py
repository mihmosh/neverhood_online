#!/usr/bin/env python3
"""Offline embedded-palette Animation preparation. Never uploads or loads a model."""

import argparse
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import zipfile

import numpy as np
from PIL import Image

from job_contract import MAX_PACK_BYTES, MODEL_SHA256, NAMESPACE, PREPROC_SPEC, job_key, keyset_digest


def sha(data):
    return hashlib.sha256(data).hexdigest()


def rgba_from_indexed(indexed, palette, width, height):
    if len(indexed) != width * height or len(palette) != 1024:
        raise ValueError("Unexpected decoded indexed raster or RGBA palette size")
    indices = np.frombuffer(indexed, dtype=np.uint8).reshape(height, width)
    colors = np.frombuffer(palette, dtype=np.uint8).reshape(256, 4)
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[:, :, :3] = colors[indices, :3]
    rgba[:, :, 3] = np.where(indices == 0, 0, 255)
    rgba[indices == 0] = 0
    return rgba.tobytes()


class Blobs:
    def __init__(self, db, root):
        self.root = root.resolve()
        self.records = {r["sha256"]: r for r in db.execute("SELECT * FROM blobs")}
        self.verified = set()

    def read(self, digest):
        row = self.records[digest]
        relative = Path(row["path"])
        path = (self.root / relative).resolve()
        if relative.is_absolute() or not path.is_relative_to(self.root):
            raise ValueError("Blob path escapes private root")
        data = path.read_bytes()
        if len(data) != row["size"] or sha(data) != digest:
            raise ValueError("Blob hash/size mismatch: " + digest)
        self.verified.add(digest)
        return data


def pack_inputs(inputs, output, max_bytes=MAX_PACK_BYTES):
    """Exact ZIP STORE size accounting, including central directory and EOCD."""
    packs = []
    current = []
    size = 22

    def finish():
        if not current:
            return
        name = f"packs/part-{len(packs):05d}.zip"
        path = output / name
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
            for key, source in current:
                info = zipfile.ZipInfo(key + ".png", date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.external_attr = 0o600 << 16
                archive.writestr(info, source.read_bytes())
        data = path.read_bytes()
        if len(data) > max_bytes:
            raise ValueError("Pack exceeds configured limit")
        packs.append({"file": name, "bytes": len(data), "sha256": sha(data),
                      "count": len(current), "jobKeys": [key for key, _ in current]})

    (output / "packs").mkdir()
    for key, source in sorted(inputs):
        entry_size = source.stat().st_size + 30 + 46 + 2 * len(key + ".png")
        if entry_size + 22 > max_bytes:
            raise ValueError("Single PNG cannot fit pack limit")
        if current and size + entry_size > max_bytes:
            finish()
            current = []
            size = 22
        current.append((key, source))
        size += entry_size
    finish()
    return packs


def prepare(private_root, output):
    private_root = private_root.resolve()
    output = output.resolve()
    if output == private_root or private_root.is_relative_to(output):
        raise ValueError("Output must not contain source root")
    if output.exists():
        raise ValueError("Output already exists; refusing to overwrite local state")
    source_path = private_root / "catalog.sqlite"
    with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)) as source:
        source.row_factory = sqlite3.Row
        source.execute("BEGIN")
        frames = list(source.execute("""SELECT f.*, p.blob palette_blob, p.association
            FROM decodedframes f JOIN resources r ON r.id=f.resource_id
            JOIN palettes p ON p.id=f.palette_id WHERE r.type=4 ORDER BY f.id"""))
        expected = source.execute("SELECT count(*) FROM decodedframes f JOIN resources r ON r.id=f.resource_id WHERE r.type=4").fetchone()[0]
        if len(frames) != expected or not frames:
            raise ValueError("Animation frames missing embedded palettes")
        if any(f["association"] != "embedded" for f in frames):
            raise ValueError("Non-embedded palette requires separate runtime context")
        winners = {r[0] for r in source.execute("""SELECT id FROM (
            SELECT r.id,row_number() OVER (PARTITION BY r.hash ORDER BY r.timestamp DESC,a.load_order,r.entry_index) rank
            FROM resources r JOIN archives a ON a.id=r.archive_id) WHERE rank=1""")}
        resources = list(source.execute("SELECT * FROM resources WHERE type=4 AND status='decoded' ORDER BY id"))
        blobs = Blobs(source, private_root)
        output.mkdir(parents=True)
        (output / "inputs").mkdir()
        with closing(sqlite3.connect(output / "jobs.sqlite")) as db, db:
            source.backup(db)
            db.executescript("""
                CREATE TABLE model_config(id TEXT PRIMARY KEY,model_sha256 TEXT NOT NULL,preproc_spec TEXT NOT NULL,config_json TEXT NOT NULL);
                CREATE TABLE jobs(job_key TEXT PRIMARY KEY,width INTEGER NOT NULL,height INTEGER NOT NULL,input_path TEXT NOT NULL,input_sha256 TEXT NOT NULL,input_bytes INTEGER NOT NULL,rgba_sha256 TEXT NOT NULL,fully_transparent INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'prepared-local',model_id TEXT NOT NULL REFERENCES model_config(id));
                CREATE TABLE frame_jobs(frame_id TEXT PRIMARY KEY REFERENCES decodedframes(id),job_key TEXT NOT NULL REFERENCES jobs(job_key),original_list_id INTEGER NOT NULL,is_winner INTEGER NOT NULL,retain_flag INTEGER NOT NULL,context_status TEXT NOT NULL);
                CREATE INDEX frame_job_key ON frame_jobs(job_key);
            """)
            config = {"namespace": NAMESPACE.decode("ascii"), "preprocSpec": PREPROC_SPEC,
                      "modelSHA256": MODEL_SHA256, "scale": 4, "alpha": "source-index0-binary-nearest4x",
                      "input": "straight-RGBA8-hiddenRGB0-no-flip", "scope": "embedded-source/unverified-runtime-context",
                      "allTransparent": "retain-job-worker-may-emit-zero-RGBA4x-without-inference"}
            db.execute("INSERT INTO model_config VALUES(?,?,?,?)", ("realesrnet-embedded-v1", MODEL_SHA256, PREPROC_SPEC, json.dumps(config, sort_keys=True)))
            for resource in resources:
                for field in ("raw_blob", "payload_blob"):
                    if resource[field]:
                        blobs.read(resource[field])
            inputs = {}
            png_bytes = 0
            transparent = 0
            for frame in frames:
                indexed = blobs.read(frame["indexed_blob"])
                palette = blobs.read(frame["palette_blob"])
                if frame["png_blob"]:
                    blobs.read(frame["png_blob"])
                width, height = frame["width"], frame["height"]
                rgba = rgba_from_indexed(indexed, palette, width, height)
                key = job_key(width, height, rgba)
                if key not in inputs:
                    stream = io.BytesIO()
                    Image.frombytes("RGBA", (width, height), rgba).save(stream, format="PNG")
                    data = stream.getvalue()
                    relative = f"inputs/{key}.png"
                    path = output / relative
                    path.write_bytes(data)
                    empty = not any(rgba[3::4])
                    transparent += empty
                    db.execute("INSERT INTO jobs(job_key,width,height,input_path,input_sha256,input_bytes,rgba_sha256,fully_transparent,model_id) VALUES(?,?,?,?,?,?,?,?,?)",
                               (key,width,height,relative,sha(data),len(data),sha(rgba),int(empty),"realesrnet-embedded-v1"))
                    inputs[key] = path
                    png_bytes += len(data)
                winner = frame["resource_id"] in winners
                db.execute("INSERT INTO frame_jobs VALUES(?,?,?,?,?,?)", (frame["id"],key,frame["list_index"],int(winner),int(winner),"embedded-source/unverified-runtime-context"))
            db.commit()
            packs = pack_inputs(inputs.items(), output)
            winner_frames = db.execute("SELECT count(*) FROM frame_jobs WHERE is_winner=1").fetchone()[0]
            inventory = {str(r[0]): r[1] for r in source.execute("SELECT type,count(*) FROM resources GROUP BY type")}
            summary = {"physicalPayloads": len(resources), "physicalFrames": len(frames),
                       "winnerPayloads": sum(r["id"] in winners for r in resources), "winnerFrames": winner_frames,
                       "supersededFrames": len(frames)-winner_frames,"sourceUniqueJobs": len(inputs),
                       "duplicates":len(frames)-len(inputs),"totalPNGBytes":png_bytes,"packCount":len(packs),
                       "keysetSHA256":keyset_digest(inputs),"fullyTransparentJobs":transparent,
                       "verifiedSourceBlobs":len(blobs.verified),"inventoryResourceCountsByType":inventory,
                       "processedGPUJobs":0,"excludedGPUResourceTypes":[2,10]}
            manifest = {"version":1,"localOnly":True,"scope":"embedded-source/unverified-runtime-context",
                        "notClaimed":"all-game RGB runtime context closure; BMP/cursor cells and Smacker are not processed",
                        "sourcePrivateRoot":str(private_root),"database":"jobs.sqlite","model":config,
                        "workerContract":{"discovery":"list ZIP packs by input prefix; no global manifest upload",
                                          "verification":"SSM expected unique job count + keysetSHA256; PNG names <jobkey>.png",
                                          "hash":"namespace + modelSHA256 ASCII + NUL + preprocSpec ASCII + NUL + uint32LE(width,height) + RGBA8"},
                        "summary":summary,"packs":packs}
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[4]
    parser.add_argument("--private-root",type=Path,default=root / "private-assets")
    parser.add_argument("--output",type=Path,default=root / "private-assets/upscaling/full-game-v1")
    parser.add_argument("--summary", action="store_true", help="Print machine-readable JSON counts")
    args = parser.parse_args()
    summary = prepare(args.private_root, args.output)
    print(json.dumps(summary, sort_keys=True, indent=None if args.summary else 2))


if __name__ == "__main__":
    main()
