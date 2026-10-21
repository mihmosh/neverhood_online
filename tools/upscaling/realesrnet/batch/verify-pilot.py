#!/usr/bin/env python3
"""Local-only pilot quality gate. No inference, downloads, or cloud imports."""

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

MASK_POLICY = "index0-binary-nearest4x-hiddenrgb0"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text())


def checked_bytes(path, expected):
    data = path.read_bytes()
    if sha(data) != expected:
        raise ValueError(f"SHA256 mismatch: {path}")
    return data


def rgba(data):
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG" or image.mode != "RGBA":
            raise ValueError("Expected PNG RGBA")
        return np.array(image)


def check_output(source, output):
    alpha = source[:, :, 3]
    if not set(np.unique(alpha)).issubset({0,255}):
        raise ValueError("Source alpha is not binary")
    if np.any(source[:, :, :3][alpha == 0]):
        raise ValueError("Source hidden RGB is not zero")
    expected_alpha = alpha.repeat(4,axis=0).repeat(4,axis=1)
    if output.shape != (*expected_alpha.shape,4):
        raise ValueError("Output is not exact 4x source size")
    if not np.array_equal(output[:, :, 3],expected_alpha):
        raise ValueError("Output alpha differs from original binary nearest4x mask")
    if np.any(output[:, :, :3][expected_alpha == 0]):
        raise ValueError("Output hidden RGB is not zero")
    return expected_alpha != 0


def rgb_metrics(output, reference, mask):
    if reference.shape[:2] != output.shape[:2] or reference.shape[2] not in (3,4):
        raise ValueError("Cached reference geometry/mode differs")
    delta = np.abs(output[:, :, :3].astype(np.int16)-reference[:, :, :3].astype(np.int16))[mask]
    if not delta.size:
        raise ValueError("Cached reference has no foreground RGB to compare")
    return {"maxChannelDelta":int(delta.max()),"MAE":float(delta.mean()),"foregroundPixels":int(mask.sum())}


def verify(work, gpu_total_mib=None, max_delta=1, max_mae=0.05):
    result = {"version":1,"localOnly":True,"passed":False,"reasons":[],"metrics":{},
              "thresholds":{"maxChannelDelta":max_delta,"MAE":max_mae,"maxReservedFraction":0.8},
              "comparisonPolicy":"Cached RGB inside original nearest4x binary source alpha only; cached neural alpha ignored",
              "modelSHA256":MODEL_SHA256,"preprocSpec":PREPROC_SPEC}
    reasons = result["reasons"]
    try:
        if max_delta < 0 or max_mae < 0 or not np.isfinite(max_mae):
            raise ValueError("Invalid comparison thresholds")
        summary_path = work / "pilot-summary.json"
        summary = load(summary_path)
        result["summarySHA256"] = sha(summary_path.read_bytes())
        if summary.get("status") != "pilot-complete" or summary.get("counts",{}).get("done") != 12:
            raise ValueError("Pilot summary must report pilot-complete with exactly 12 done jobs")
        invocation_path = work / "pilot-invocation.json"
        if invocation_path.exists():
            invocation = load(invocation_path)
            if invocation.get("Status",invocation.get("SSMStatus")) != "Success":
                raise ValueError("Local SSM invocation is not Success")
            if "ResponseCode" in invocation and invocation["ResponseCode"] != 0:
                raise ValueError("Local SSM invocation response code is nonzero")
            result["invocationSHA256"] = sha(invocation_path.read_bytes())
        keys = summary.get("pilot_keys",[])
        if not isinstance(keys,list) or len(keys) != 12 or len(set(keys)) != 12:
            raise ValueError("Pilot must contain exactly 12 distinct job keys")
        hardware_path = work / "localhardware.json"
        if hardware_path.exists():
            total = load(hardware_path)["totalMemoryBytes"]
        elif gpu_total_mib is not None:
            total = gpu_total_mib * 1024 * 1024
        else:
            raise ValueError("Provide localhardware.json totalMemoryBytes or --gpu-total-mib")
        peak = summary.get("peak_reserved_bytes")
        if not isinstance(total,(int,float)) or not isinstance(peak,(int,float)) or not (0 < peak <= total) or not np.isfinite(total):
            raise ValueError("Missing or invalid actual GPU memory measurement")
        result["metrics"]["memory"] = {"totalMemoryBytes":total,"peakReservedBytes":peak,
            "reservedFraction":peak/total,"headroomFraction":1-peak/total}
        if peak > total*0.8:
            reasons.append("GPU reserved-memory headroom below 20 percent")
        metadata_path = work / "pilot-output-metadata.json"
        metadata = load(metadata_path)
        result["metadataSHA256"] = sha(metadata_path.read_bytes())
        if set(metadata) != set(keys):
            raise ValueError("Output metadata keyset differs from 12 pilot keys")
        refs_path = work / "pilot-references.json"
        refs_doc = load(refs_path)
        if refs_doc["modelSHA256"] != MODEL_SHA256:
            raise ValueError("Cached reference model identity differs")
        result["referencesSHA256"] = sha(refs_path.read_bytes())
        with closing(sqlite3.connect((work / "jobs.sqlite").as_uri()+"?mode=ro",uri=True)) as db:
            db.row_factory = sqlite3.Row
            jobs = {row["job_key"]:dict(row) for row in db.execute("SELECT * FROM jobs")}
        compared = {}
        checked = {}
        for key in keys:
            try:
                job = jobs[key]
                path = (work / job["input_path"]).resolve()
                if not path.is_relative_to(work):
                    raise ValueError("Source input path escapes work directory")
                source_bytes = checked_bytes(path,job["input_sha256"])
                source = rgba(source_bytes)
                if source.shape != (job["height"],job["width"],4) or job_key(job["width"],job["height"],source.tobytes()) != key:
                    raise ValueError("Source pixels/dimensions do not match job key")
                if sha(source.tobytes()) != job["rgba_sha256"]:
                    raise ValueError("Source canonical RGBA SHA differs")
                output_path = work / "pilot-output" / (key + ".png")
                data = output_path.read_bytes()
                output_sha = sha(data)
                expected = {"sha256":output_sha,"input-jobkey":key,"input-sha256":job["input_sha256"],
                    "model-sha256":MODEL_SHA256,"mask-policy":MASK_POLICY,"preproc-spec":PREPROC_SPEC,
                    "width":str(job["width"]*4),"height":str(job["height"]*4),"scale":"4"}
                if metadata[key] != expected:
                    raise ValueError("Output SHA/provenance metadata differs from exact worker contract")
                output = rgba(data)
                mask = check_output(source,output)
                checked[key] = {"sha256":output_sha,"width":job["width"]*4,"height":job["height"]*4,"alphaExact":True,"hiddenRGBZero":True}
                if key not in refs_doc["references"]:
                    continue
                ref = refs_doc["references"][key]
                if (ref["modelSHA256"] != MODEL_SHA256 or ref["preprocSpec"] != PREPROC_SPEC
                        or ref["canonicalRGBASHA256"] != job["rgba_sha256"]):
                    raise ValueError("Cached reference source/model identity differs")
                old_source_bytes = checked_bytes(Path(ref["sourceInputRGBAPath"]),ref["sourceInputRGBASHA256"])
                old_source = rgba(old_source_bytes)
                if not set(np.unique(old_source[:,:,3])).issubset({0,255}):
                    raise ValueError("Cached source alpha is not binary")
                old_source[old_source[:,:,3] == 0] = 0
                if not np.array_equal(old_source,source):
                    raise ValueError("Cached original and pilot source canonical pixels differ")
                neural_bytes = checked_bytes(Path(ref["cachedNeuralPath"]),ref["cachedNeuralSHA256"])
                with Image.open(io.BytesIO(neural_bytes)) as image:
                    if image.format != "PNG" or image.mode not in ("RGB","RGBA"):
                        raise ValueError("Cached neural reference is not lossless RGB/RGBA PNG")
                    reference = np.array(image)
                metrics = rgb_metrics(output,reference,mask)
                metrics.update({"cachedNeuralSHA256":ref["cachedNeuralSHA256"],"sourceInputRGBAFileSHA256":ref["sourceInputRGBASHA256"]})
                compared[key] = metrics
                if metrics["maxChannelDelta"] > max_delta or metrics["MAE"] > max_mae:
                    reasons.append(key + ": cached CPU RGB exceeds comparison thresholds")
            except Exception as error:
                reasons.append(key + ": " + str(error))
        result["metrics"]["outputs"] = checked
        result["metrics"]["cachedReferenceComparisons"] = compared
        if not compared:
            reasons.append("No actual verified cached CPU reference comparison completed")
        if len(checked) != 12:
            reasons.append("Not all 12 output images passed structural/provenance validation")
    except Exception as error:
        reasons.append(str(error))
    result["passed"] = not reasons
    (work / "pilot-approval.json").write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps(result,sort_keys=True))
    return 0 if result["passed"] else 1


def self_test():
    source = np.zeros((2,3,4),dtype=np.uint8)
    source[0,0] = [10,20,30,255]
    output = source.repeat(4,axis=0).repeat(4,axis=1)
    mask = check_output(source,output)
    reference = output.copy()
    reference[:,:,3] = 17
    assert rgb_metrics(output,reference,mask)["MAE"] == 0
    reference[0,0,0] += 1
    metrics = rgb_metrics(output,reference,mask)
    assert metrics["maxChannelDelta"] == 1 and abs(metrics["MAE"]-1/48) < 1e-12
    bad_alpha = output.copy()
    bad_alpha[0,0,3] = 254
    bad_hidden = output.copy()
    bad_hidden[4,4] = [1,0,0,0]
    for bad in (output[:4],bad_alpha,bad_hidden):
        try:
            check_output(source,bad)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid output accepted")
    print("Synthetic in-memory pixel checks passed; no pilot outputs read or generated")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir",type=Path,default=Path(__file__).resolve().parents[4]/"private-assets/upscaling/full-game-v1")
    parser.add_argument("--gpu-total-mib",type=float)
    parser.add_argument("--max-channel-delta",type=int,default=1)
    parser.add_argument("--max-mae",type=float,default=0.05)
    parser.add_argument("--self-test",action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        raise SystemExit(verify(args.work_dir.resolve(),args.gpu_total_mib,args.max_channel_delta,args.max_mae))
