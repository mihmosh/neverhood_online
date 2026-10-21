#!/usr/bin/env python3
"""Offline semantic catalog and lossless PNG archive plan; no inference or network."""

import argparse
from contextlib import closing
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import struct
import sys

import numpy as np
from PIL import Image

from job_contract import job_key, keyset_digest

spec = importlib.util.spec_from_file_location("prepare_catalog", Path(__file__).with_name("prepare-catalog.py"))
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def local_path(root, relative):
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root.resolve()):
        raise ValueError("Path escapes local root: " + str(relative))
    return path


def animation_lists(data):
    """Read list ranges, not sprite offsets or a guessed flattened frame index."""
    def unpack(fmt, offset):
        if offset < 0 or offset + struct.calcsize(fmt) > len(data):
            raise ValueError("Truncated animation payload")
        return struct.unpack_from(fmt, data, offset)

    count, info, _, _ = unpack("<HHII", 0)
    lists = []
    ordinal = 0
    for index in range(count):
        requested, frames, offset = unpack("<IHH", 12 + index * 8)
        start = info + offset
        if start + frames * 32 > len(data):
            raise ValueError("Truncated animation frame range")
        lists.append({"requestedHash": requested, "listIndex": index,
                      "frameCount": frames, "frameInfoOffset": start,
                      "physicalOrdinalStart": ordinal})
        ordinal += frames
    return lists


def png(data, dimensions):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or image.mode != "RGBA" or getattr(image, "n_frames", 1) != 1:
            raise ValueError("Expected single RGBA PNG")
        if image.size != dimensions:
            raise ValueError("PNG dimensions mismatch")
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        return np.array(image)


def build_catalog(batch, private_root=None):
    batch = batch.resolve()
    manifest_data = (batch / "manifest.json").read_bytes()
    manifest = json.loads(manifest_data)
    private_root = (private_root or Path(manifest["sourcePrivateRoot"])).resolve()
    records_data = (batch / "hd-animation-assets.jsonl").read_bytes()
    records = {}
    for line in records_data.splitlines():
        record = json.loads(line)
        identifier = record["source_frame_id"]
        if identifier in records:
            raise ValueError("Duplicate source frame record: " + identifier)
        records[identifier] = record

    with closing(sqlite3.connect(local_path(batch, manifest["database"]).as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("BEGIN")
        jobs = {r["job_key"]: dict(r) for r in db.execute("SELECT * FROM jobs")}
        if manifest["model"]["scale"] != 4:
            raise ValueError("Unsupported batch scale")
        frames = [dict(r) for r in db.execute("""SELECT f.*,j.job_key,j.is_winner,j.retain_flag,j.original_list_id
            FROM decodedframes f JOIN frame_jobs j ON j.frame_id=f.id
            ORDER BY f.resource_id,f.list_index,f.frame_index""")]
        if set(records) != {f["id"] for f in frames}:
            raise ValueError("Saved frame records do not cover the prepared frame set")
        summary = manifest["summary"]
        if (len(jobs) != summary["sourceUniqueJobs"] or len(frames) != summary["physicalFrames"]
                or keyset_digest(jobs) != summary["keysetSHA256"]):
            raise ValueError("Manifest count/keyset mismatch")
        resources = {r["id"]: dict(r) for r in db.execute("SELECT * FROM resources")}
        archives = {r["id"]: dict(r) for r in db.execute("SELECT * FROM archives")}
        winners = {r[0] for r in db.execute("""SELECT id FROM (
            SELECT r.id,row_number() OVER (PARTITION BY r.hash ORDER BY r.timestamp DESC,a.load_order,r.entry_index) rank
            FROM resources r JOIN archives a ON a.id=r.archive_id) WHERE rank=1""")}
        palettes = {r["id"]: dict(r) for r in db.execute("SELECT * FROM palettes")}
        blobs = preparation.Blobs(db, private_root)
        saved_outputs = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='hd_outputs'").fetchone():
            saved_outputs = {r["job_key"]: dict(r) for r in db.execute("SELECT * FROM hd_outputs")}

        images = {}
        expected_outputs = {}
        source_arrays = {}
        for key, job in sorted(jobs.items()):
            data = local_path(batch, job["input_path"]).read_bytes()
            if sha(data) != job["input_sha256"] or len(data) != job["input_bytes"]:
                raise ValueError("Source input PNG hash/size mismatch: " + key)
            array = png(data, (job["width"], job["height"]))
            if sha(array.tobytes()) != job["rgba_sha256"] or job_key(job["width"], job["height"], array.tobytes()) != key:
                raise ValueError("Source input pixels/job hash mismatch: " + key)
            source_arrays[key] = array
            images[key] = {"id": key, "jobHash": key, "path": str(batch / "outputs" / (key + ".png")),
                           "inputPNG": {"path": str(local_path(batch, job["input_path"])), "sha256": sha(data)},
                           "width": job["width"] * 4, "height": job["height"] * 4}

        plans = {}
        excluded = []
        sources = {}
        unknown_sources = []
        for frame in frames:
            record = records[frame["id"]]
            metadata = json.loads(frame["metadata_json"])
            for field in ("job_key", "width", "height", "list_index", "frame_index", "is_winner", "retain_flag", "original_list_id"):
                if record[field] != frame[field]:
                    raise ValueError("Saved frame field mismatch: " + field)
            if record["metadata"] != metadata or record["scale"] != 4:
                raise ValueError("Saved metadata/scale mismatch")
            winner = frame["resource_id"] in winners
            if bool(frame["is_winner"]) != winner or bool(frame["retain_flag"]) != winner:
                raise ValueError("Prepared winner/retention mismatch")
            key = frame["job_key"]
            expected = {"sha256": record.get("output_sha256"), "bytes": record.get("output_bytes")}
            saved = saved_outputs.get(key)
            if saved and any(expected[k] is not None and expected[k] != saved[k] for k in expected):
                raise ValueError("Saved output database/JSONL mismatch")
            if saved:
                expected = {k: saved[k] for k in expected}
            if key in expected_outputs and expected_outputs[key] != expected:
                raise ValueError("Conflicting saved output records")
            expected_outputs[key] = expected
            sources[frame["id"]] = {"status": "unknown", "palette": None, "indexedRaster": None}
            try:
                palette = palettes[frame["palette_id"]]
                if palette["association"] != "embedded" or palette["resource_id"] != frame["resource_id"]:
                    raise ValueError("Non-authoritative palette association")
                palette_bytes = blobs.read(palette["blob"])
                indexed = blobs.read(frame["indexed_blob"])
                rgba = preparation.rgba_from_indexed(indexed, palette_bytes, frame["width"], frame["height"])
                if rgba != source_arrays[key].tobytes():
                    raise ValueError("Authoritative source raster differs from prepared input")
                sources[frame["id"]] = {
                    "status": "verified-extractor", "palette": {"id": palette["id"], "sha256": palette["blob"],
                        "path": str(local_path(private_root, blobs.records[palette["blob"]]["path"])),
                        "encoding": "256-RGBA8-original-bytes", "bytesHex": palette_bytes.hex()},
                    "indexedRaster": {"sha256": frame["indexed_blob"], "path": str(local_path(private_root, blobs.records[frame["indexed_blob"]]["path"])),
                        "encoding": "uint8-row-major-tight", "bytes": len(indexed)}}
            except (FileNotFoundError, KeyError) as error:
                sources[frame["id"]]["reason"] = str(error)
                unknown_sources.append(frame["id"])
            if not winner:
                excluded.append({"sourceFrameId": frame["id"], "jobHash": key, "reason": "superseded-resource", "metadata": metadata})
                continue
            resource = resources[frame["resource_id"]]
            plan = plans.setdefault(resource["id"], {"resource": resource, "container": archives[resource["archive_id"]],
                "archive": {"format": "ZIP", "compression": "STORE", "pixelEncoding": "PNG", "reencode": False},
                "frames": [], "runtimeMappings": []})
            plan["frames"].append({"sourceFrameId": frame["id"], "requestedHash": frame["requested_hash"],
                "resolvedHash": frame["resolved_hash"], "listIndex": frame["list_index"], "frameIndex": frame["frame_index"],
                "imageId": key, "width": frame["width"], "height": frame["height"], "metadata": metadata,
                "source": sources[frame["id"]], "member": f"images/{key}.png"})

        mapping_issues = []
        unloadable_requests = []
        for identifier, plan in sorted(plans.items()):
            try:
                payload = blobs.read(plan["resource"]["payload_blob"])
                lists = animation_lists(payload)
            except (FileNotFoundError, KeyError) as error:
                mapping_issues.append({"resourceId": identifier, "reason": str(error)})
                continue
            physical = {(f["listIndex"], f["frameIndex"]): f for f in plan["frames"]}
            if len(physical) != sum(item["frameCount"] for item in lists):
                raise ValueError("Extractor/payload frame count mismatch")
            for item in lists:
                for index in range(item["frameCount"]):
                    frame = physical[(item["listIndex"], index)]
                    if frame["requestedHash"] != item["requestedHash"]:
                        raise ValueError("Extractor/payload animation hash mismatch")
                    frame["physicalOrdinal"] = item["physicalOrdinalStart"] + index
                    frame["frameInfoOffset"] = item["frameInfoOffset"] + index * 32
                    values = struct.unpack_from("<IHhhHHhhhhHHHI", payload, frame["frameInfoOffset"])
                    names = ("frameHash", "durationTicks", "x", "y", "width", "height", "deltaX", "deltaY",
                             "collisionX", "collisionY", "collisionWidth", "collisionHeight", "reserved", "spriteOffset")
                    for name, value in zip(names, values):
                        if name in frame["metadata"] and frame["metadata"][name] != value:
                            raise ValueError("Extractor/payload frame metadata mismatch: " + name)
                    if (frame["width"], frame["height"]) != (values[4], values[5]):
                        raise ValueError("Extractor/payload frame dimensions mismatch")
            plan["internalAnimations"] = lists
            for alias in db.execute("SELECT * FROM aliases WHERE resolved_id=? AND status='resolved' ORDER BY requested_id", (identifier,)):
                if alias["requested_id"] not in winners:
                    raise ValueError("Nonwinner alias in extractor")
                selected = next((item for item in lists if item["requestedHash"] == alias["requested_hash"]), None)
                if selected is None:
                    # A physical container hash need not itself name an internal animation.
                    unloadable_requests.append({"requestedResourceId": alias["requested_id"],
                        "requestedHash": alias["requested_hash"], "resolvedResourceId": identifier,
                        "reason": "no-matching-internal-animation; AnimResource::load returns false"})
                    continue
                for index in range(selected["frameCount"]):
                    frame = physical[(selected["listIndex"], index)]
                    plan["runtimeMappings"].append({"requestedResourceId": alias["requested_id"],
                        "requestedContainer": archives[resources[alias["requested_id"]]["archive_id"]],
                        "aliasChain": json.loads(alias["chain_json"]), "requestedHash": alias["requested_hash"],
                        "resolvedHash": plan["resource"]["hash"], "frameIndex": index, "imageId": frame["imageId"],
                        "width": frame["width"], "height": frame["height"], "listIndex": frame["listIndex"],
                        "physicalOrdinal": frame["physicalOrdinal"], "sourceFrameId": frame["sourceFrameId"],
                        "flip": "runtime-only; apply flipX/flipY after lookup"})
            plan["members"] = [{"member": f"images/{key}.png", "imageId": key} for key in sorted({f["imageId"] for f in plan["frames"]})]

        missing, invalid, unbound = [], [], []
        unexpected = sorted(str(p.relative_to(batch)) for p in (batch / "outputs").rglob("*.png")
                            if p.parent != batch / "outputs" or p.stem not in jobs)
        for key, image in images.items():
            expected = expected_outputs[key]
            image["savedOutput"] = expected
            if expected["sha256"] is None:
                unbound.append(key)
            path = Path(image["path"])
            if not path.exists():
                image["validation"] = "missing"
                missing.append(key)
                continue
            try:
                data = local_path(batch, "outputs/" + key + ".png").read_bytes()
                digest = sha(data)
                if (expected["sha256"] is not None and digest != expected["sha256"]
                        or expected["bytes"] is not None and len(data) != expected["bytes"]):
                    raise ValueError("Output saved hash/size mismatch")
                output = png(data, (image["width"], image["height"]))
                alpha = np.repeat(np.repeat(source_arrays[key][:, :, 3], 4, axis=0), 4, axis=1)
                if not np.array_equal(output[:, :, 3], alpha) or np.any(output[alpha == 0, :3]):
                    raise ValueError("Output alpha mask/hidden RGB mismatch")
                image.update(validation="verified" if expected["sha256"] else "contents-only-unbound", sha256=digest, bytes=len(data))
            except (ValueError, OSError, SyntaxError) as error:
                image["validation"] = "invalid"
                invalid.append({"imageId": key, "reason": str(error)})

        if len(excluded) != summary["supersededFrames"] or len(frames) - len(excluded) != summary["winnerFrames"]:
            raise ValueError("Manifest winner/exclusion count mismatch")
        return {"schemaVersion": 1, "kind": "animation-lossless-archive-preparation-plan", "localOnly": True,
            "runtimeContextVerified": False,
            "provenance": {"manifestSHA256": sha(manifest_data), "frameRecordsSHA256": sha(records_data),
                           "database": str(batch / manifest["database"]), "model": manifest["model"]},
            "semanticKey": ["requestedHash", "resolvedHash", "frameIndex", "width", "height"],
            "hashEncoding": "unsigned uint32 JSON numbers", "flip": "separate runtime flipX/flipY; PNGs are unflipped",
            "limitations": ["Embedded-source colors only; runtime palette, recoloring, transparency and surface capacity require runtime checks.",
                            "No BMP/cursor or Smacker replacement coverage; no all-game RGB palette closure claimed.",
                            "durationTicks are original engine counters, not milliseconds; frameHash is not a unique image ID.",
                            "physicalOrdinal is list-order extraction ordinal, not AnimResource frameIndex."],
            "validation": {"valid": not (missing or invalid or unbound or unknown_sources or mapping_issues or unexpected),
                "expectedImages": len(images), "verifiedImages": sum(i["validation"] == "verified" for i in images.values()),
                "missingImages": missing, "invalidImages": invalid, "unboundImages": unbound, "unexpectedImages": unexpected,
                "unknownSources": unknown_sources, "mappingIssues": mapping_issues,
                "resourcePlans": len(plans), "runtimeMappings": sum(len(p["runtimeMappings"]) for p in plans.values()),
                "unloadableRequests": len(unloadable_requests),
                "winnerFrames": len(frames) - len(excluded), "supersededFrames": len(excluded)},
            "images": list(images.values()), "resources": list(plans.values()), "excludedFrames": excluded,
            "unloadableRequests": unloadable_requests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", type=Path, default=Path(__file__).resolve().parents[4] / "private-assets/upscaling/full-game-v1")
    parser.add_argument("--private-root", type=Path)
    parser.add_argument("--summary", action="store_true", help="Print validation only instead of the complete private plan")
    parser.add_argument("--output", type=Path, help="Create a new private JSON catalog; never overwrite")
    args = parser.parse_args()
    catalog = build_catalog(args.batch, args.private_root)
    if args.output:
        private = Path(__file__).resolve().parents[4] / "private-assets"
        output = args.output.absolute()
        if not output.parent.resolve().is_relative_to(private.resolve()) or output.parent.resolve() != output.parent:
            raise ValueError("Catalog output must have an existing nonsymlink private parent")
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(catalog, stream, sort_keys=True, indent=2)
            stream.write("\n")
        print(json.dumps({"output": str(output), "validation": catalog["validation"]}, sort_keys=True))
    else:
        print(json.dumps(catalog["validation"] if args.summary else catalog, sort_keys=True, indent=2))
    return 0 if catalog["validation"]["valid"] else 2


if __name__ == "__main__":
    sys.exit(main())
