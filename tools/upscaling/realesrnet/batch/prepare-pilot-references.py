#!/usr/bin/env python3
"""Verify local historical lossless references against exact full-game RGBA jobs."""

import argparse
from contextlib import closing
import hashlib
import io
import json
from pathlib import Path
import sqlite3

import numpy as np
from PIL import Image

from job_contract import MODEL_SHA256, PREPROC_SPEC, job_key


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verified(path, expected):
    data = path.read_bytes()
    if digest(data) != expected:
        raise ValueError(f"SHA256 mismatch: {path}")
    return data


def under(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Reference path escapes root")
    return path


def canonical(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.mode != "RGBA":
            raise ValueError("Source must be lossless RGBA")
        rgba = np.array(image)
        if not set(np.unique(rgba[:, :, 3])).issubset({0,255}):
            raise ValueError("Source alpha must already be binary; refusing to threshold")
        rgba[rgba[:, :, 3] == 0] = 0
        return image.size, rgba.tobytes()


def prepare(batch, cache, sources):
    output = batch / "pilot-references.json"
    if output.exists():
        raise ValueError("Local pilot references already exist; refusing overwrite")
    manifest_bytes = (cache / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    source_manifest_bytes = verified(sources / "manifest.json",manifest["inputManifestSHA256"])
    source_manifest = json.loads(source_manifest_bytes)
    if manifest["model"]["sha256"] != MODEL_SHA256 or manifest["model"]["scale"] != 4:
        raise ValueError("Historical model does not match job contract")
    originals = {case["resource"]:case for case in source_manifest["cases"]}
    with closing(sqlite3.connect((batch / "jobs.sqlite").resolve().as_uri() + "?mode=ro",uri=True)) as db:
        db.row_factory = sqlite3.Row
        jobs = {r["job_key"]:dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY job_key")}
    references = {}
    scanned = 0
    mismatches = 0
    sequence_hashes = {}
    for case in manifest["cases"]:
        case_root = under(cache,case["resource"])
        sequence_path = case_root / "sequence.json"
        sequence_bytes = sequence_path.read_bytes()
        sequence = json.loads(sequence_bytes)
        sequence_hashes[str(sequence_path)] = digest(sequence_bytes)
        if sequence != case:
            raise ValueError("Cache sequence differs from manifest")
        source_case = originals[case["resource"]]
        source_frames = {frame["index"]:frame for frame in source_case["frames"]}
        for frame in sequence["frames"]:
            original = source_frames[frame["index"]]
            if original["sha256"] != frame["sha256"] or frame["originalSHA256"] != frame["sha256"]:
                raise ValueError("Cached source identity differs from old input")
            source_path = under(sources,original["file"])
            source_bytes = verified(source_path,original["sha256"])
            verified(under(case_root,frame["originalFile"]),frame["originalSHA256"])
            neural_path = under(case_root,frame["neuralFile"])
            neural_bytes = verified(neural_path,frame["neuralSHA256"])
            (width,height), rgba = canonical(source_bytes)
            if [width,height] != frame["size"]:
                raise ValueError("Historical source dimensions disagree")
            with Image.open(io.BytesIO(neural_bytes)) as image:
                if image.mode not in ("RGB","RGBA") or image.size != (width*4,height*4):
                    raise ValueError("Cached neural PNG geometry/mode differs")
                image.load()
            scanned += 1
            key = job_key(width,height,rgba)
            if key not in jobs:
                mismatches += 1
                continue
            job = jobs[key]
            batch_path = under(batch,job["input_path"])
            batch_bytes = verified(batch_path,job["input_sha256"])
            size, batch_rgba = canonical(batch_bytes)
            if size != (width,height) or batch_rgba != rgba or digest(rgba) != job["rgba_sha256"]:
                raise ValueError("Job key found but decoded canonical pixels differ")
            reference = references.setdefault(key,{
                "jobKey":key,"width":width,"height":height,"modelSHA256":MODEL_SHA256,
                "preprocSpec":PREPROC_SPEC,"canonicalRGBASHA256":digest(rgba),
                "sourceInputRGBAPath":str(source_path),"sourceInputRGBASHA256":original["sha256"],
                "batchInputRGBAPath":str(batch_path),"batchInputRGBASHA256":job["input_sha256"],
                "cachedNeuralPath":str(neural_path),"cachedNeuralSHA256":frame["neuralSHA256"],
                "label":case["label"],"features":source_case.get("features",[]),"physicalReferences":[]})
            reference["physicalReferences"].append({"resource":case["resource"],"frameIndex":frame["index"],"frameId":frame["frameId"]})
    rows = list(jobs.values())
    candidates = rows[:1] + [max(rows,key=lambda r:r["width"]*r["height"]),min(rows,key=lambda r:r["width"]*r["height"])]
    candidates += [row for row in rows if row["fully_transparent"]][:1]
    pilot = {}
    for row in candidates + rows:
        if len(pilot) == min(12,len(rows)):
            break
        pilot[row["job_key"]] = row
    overlap = sorted(set(pilot) & references.keys())
    def rank(ref):
        text = (ref["label"] + " " + " ".join(ref["features"])).lower()
        return (not (ref["width"] > 8 and ref["height"] > 8),
                not any(word in text for word in ("foot","feet","body","walk","klaymen")),
                ref["jobKey"] not in overlap,ref["width"]*ref["height"],ref["jobKey"])
    recommended = [r["jobKey"] for r in sorted(references.values(),key=rank)[:3]]
    result = {"version":1,"localOnly":True,"modelSHA256":MODEL_SHA256,
              "comparisonPolicy":"Compare cached RGB only inside original source binary alpha repeated 4x; ignore cached neural alpha entirely. No RGB error comparison has been performed here.",
              "identityPolicy":"Exact decoded canonical straight RGBA8, hidden RGB zero, binary alpha preserved; no index64 reinterpretation, flips, or palette substitution.",
              "cacheManifestPath":str(cache / "manifest.json"),"cacheManifestSHA256":digest(manifest_bytes),
              "inputManifestPath":str(sources / "manifest.json"),"inputManifestSHA256":digest(source_manifest_bytes),
              "sequenceSHA256":sequence_hashes,"cachedFramesVerified":scanned,"unmatchedCachedFrames":mismatches,
              "matchedJobCount":len(references),"recommendedJobKeys":recommended,
              "defaultPilot12JobKeys":list(pilot),"defaultPilot12OverlapJobKeys":overlap,
              "references":references}
    output.write_text(json.dumps(result,indent=2,sort_keys=True) + "\n")
    print(json.dumps({"matchedCount":len(references),"topSamples":[{"jobKey":key,"dimensions":[references[key]["width"],references[key]["height"]]} for key in recommended],"defaultPilot12OverlapJobKeys":overlap},sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch",type=Path,default=Path(__file__).resolve().parents[4] / "private-assets/upscaling/full-game-v1")
    parser.add_argument("--cache",type=Path,default=Path("/home/mosha/neverhood-upscaling/data/animation-tests/realesrnet-20-v1"))
    parser.add_argument("--sources",type=Path,default=Path("/home/mosha/neverhood-upscaling/data/animation-tests/inputs-v1"))
    args = parser.parse_args()
    prepare(args.batch.resolve(),args.cache.resolve(),args.sources.resolve())
