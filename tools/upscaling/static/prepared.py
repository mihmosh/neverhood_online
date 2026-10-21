"""Read-only, source-verified catalog of the prepared two-room static scope."""

from copy import deepcopy
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import zlib

import numpy as np
from PIL import Image

import pilot


SCENES = {
    "Scene1001": ("room1-hd/work-v1", "4086520e",
                  ("2080a3a8", "809861a6", "89c03848", "15288120", "8c066150")),
    "Scene1002": ("room2-hd/baselines-v1", "12c23307",
                  ("152c1313", "060000a0", "b2a423b0", "316e0772",
                   "316c4bb4", "06149428", "312c8774", "b3242310")),
}
OCCLUDERS = {*pilot.OCCLUDERS, "2080a3a8", "8c066150", "316c4bb4"}


def state_rules(scene, resource):
    rules = {"engineOwned": True, "initialPriority": pilot.PRIORITIES[resource],
             "visibility": "Inserted on scene construction; no visibility change in this static binding.",
             "clipping": "Original engine clipping and placement remain authoritative."}
    if scene == "Scene1001":
        if resource == "2080a3a8":
            rules["clipping"] = "Right draw-rectangle edge clips Klaymen and the door (door only if !V_DOOR_BUSTED)."
        elif resource == "8c066150":
            rules.update(condition={"V_WINDOW_OPEN": False},
                         visibility="Inserted only when V_WINDOW_OPEN is false.",
                         clipping="Its draw rectangle clips the animated window.")
        elif resource == "15288120":
            rules.update(visibility="Initially hidden; message 0x480B shows it for eight update ticks, then hides it.",
                         activationMessage="0x480B", visibleTicks=8, initiallyVisible=False,
                         collisionPriority=1100)
    else:
        rules["clipping"] = ("Klaymen and ladder hands use arch-derived clip rectangles according to entry/floor state; "
                             "peek hand shares the top clip. Door and spy use backing/arch-part2 clip bounds. "
                             "Rings use the ceiling draw-rectangle top as their clip boundary. Roles can overlap.")
        if resource == "316e0772":
            rules["visibility"] = "Deleted on the first !_isKlaymenFloor && Klaymen.y > 230 transition."
        if resource in ("152c1313", "316c4bb4"):
            rules["priorityMessages"] = {"0x8000": 995, "0x8001": 1015}
    return rules


def room1_adapter(manifest):
    """Supply the pilot's case view without replacing the original manifest."""
    adapted = deepcopy(manifest)
    adapted["paletteResource"] = "4086520e"
    adapted["cases"] = []
    for entry in manifest["entries"]:
        if entry["kind"] != "layer":
            continue
        adapted["cases"].append({
            "resource": entry["resource"], "actor": "static", "remove64": False,
            "capacity": entry["nativeSize"], "frames": [{
                "index": entry["frame"], "frameId": entry["frameId"], "job": entry["job"],
                "sourceIndexedSHA256": entry["sourceIndexedSHA256"], "metadata": entry["metadata"],
                "rasterVariants": [{"flipX": entry["flipX"], "surfaceSize": entry["surfaceSize"],
                                    "indexedSHA256": entry["sourceSHA256"]}],
            }],
        })
    return adapted


def build_prepared_catalog(root: Path, prepared_root: Path, catalog_root: Path) -> dict:
    """Verify all thirteen declared frame-zero bindings; never write or infer."""
    root, prepared_root, catalog_root = (Path(p).resolve() for p in (root, prepared_root, catalog_root))
    files = []

    def record(path, role, *, metadata=False):
        data = path.read_bytes()
        item = {"path": str(path), "sha256": pilot.digest(data), "role": role}
        if metadata:
            item["metadata"] = json.loads(data)
        files.append(item)
        return item

    catalog = record(pilot.checked_path(catalog_root, "manifest.json"), "catalog-manifest", metadata=True)
    binding = catalog["metadata"]["sourceBinding"]
    code = [record(Path(__file__).resolve().with_name(name), "implementation")
            for name in ("prepared.py", "pilot.py", "pipeline.py")]
    engine = [record(pilot.checked_path(root, "scummvm/engines/neverhood/modules/" + name), "engine-evidence")
              for name in ("module1000.cpp", "module1000_sprites.cpp")]
    assets = []
    with closing(sqlite3.connect((catalog_root / "catalog.sqlite").as_uri() + "?mode=ro", uri=True)) as db, db:
        db.row_factory = sqlite3.Row
        for scene, (relative, palette_resource, resources) in SCENES.items():
            base = pilot.checked_path(prepared_root, relative)
            original_record = record(base / "manifest.json", scene + "-manifest", metadata=True)
            original = original_record["metadata"]
            if scene == "Scene1001":
                manifest = room1_adapter(original)
                runtime = original
                runtime_record = original_record
                backgrounds = [job for job in original["jobs"]
                               if job["resource"] == palette_resource and job["frame"] == 0 and job.get("opaque")]
                if len(backgrounds) != 1:
                    raise ValueError("Ambiguous opaque Scene1001 background job")
                background_job = backgrounds[0]
                background_path = pilot.checked_path(base, background_job["file"])
            else:
                manifest = original
                runtime_record = record(base.parent / "runtime-map-v1.json", scene + "-runtime", metadata=True)
                runtime = runtime_record["metadata"]
                if runtime["sourceManifestSHA256"] != original_record["sha256"]:
                    raise ValueError("Runtime source manifest checksum differs")
                background_path = base / "original-background.png"
                background_job = None
            if (manifest.get("scene", manifest.get("room")) != scene or runtime["room"] != scene
                    or runtime["scale"] != 4 or manifest["paletteResource"] != palette_resource
                    or runtime["sourceBinding"] != binding):
                raise ValueError("Scene or catalog source binding differs")
            rows = db.execute("SELECT DISTINCT p.blob FROM palettes p JOIN aliases a ON a.resolved_id=p.resource_id "
                              "WHERE a.requested_hash=?", (int(palette_resource, 16),)).fetchall()
            if len(rows) != 1 or rows[0]["blob"] != manifest["paletteSHA256"]:
                raise ValueError("Scene palette association differs from catalog")
            palette_bytes = pilot.blob(db, catalog_root, manifest["paletteSHA256"])
            if len(palette_bytes) != 1024 or runtime["paletteCRC32"] != f"{zlib.crc32(palette_bytes):08x}":
                raise ValueError("Runtime palette CRC or dimensions differ")
            palette = np.frombuffer(palette_bytes, np.uint8).reshape(256, 4)
            rows = db.execute("SELECT * FROM decodedframes WHERE requested_hash=?", (int(palette_resource, 16),)).fetchall()
            if len(rows) != 1 or (rows[0]["width"], rows[0]["height"]) != (640, 480):
                raise ValueError("Background catalog identity differs")
            background_row = rows[0]
            indexed = pilot.blob(db, catalog_root, background_row["indexed_blob"])
            if len(indexed) != 640 * 480:
                raise ValueError("Background indexed dimensions differ")
            expected = palette[np.frombuffer(indexed, np.uint8).reshape(480, 640), :3]
            background_record = record(background_path, scene + "-original-background")
            if background_job and background_record["sha256"] != background_job["sha256"]:
                raise ValueError("Opaque background job checksum differs")
            with Image.open(background_path) as image:
                if (image.mode not in ("RGB", "RGBA") or image.size != (640, 480)
                        or (image.mode == "RGBA" and not np.all(np.asarray(image)[:, :, 3] == 255))
                        or not np.array_equal(np.asarray(image.convert("RGB")), expected)):
                    raise ValueError("Original background differs from indexed scene palette bytes")
                background_rgb = np.asarray(image.convert("RGB"))
            background_identity = {"resource": palette_resource, "frameId": background_row["id"],
                                   "indexedSHA256": background_row["indexed_blob"],
                                   "paletteSHA256": manifest["paletteSHA256"], "sourceBinding": binding}
            for resource in resources:
                asset, entry, job = pilot.verify_binding(db, catalog_root, base, manifest, runtime, resource)
                identity = asset["sourceIdentity"]
                if identity["frame"] != 0 or entry.get("frame", 0) != 0 or job["frame"] != 0 or job["resource"] != resource:
                    raise ValueError("Expected frame-zero source job and runtime binding")
                rules = state_rules(scene, resource)
                evidence = {"constructor": {**engine[0], "lines": [127, 188] if scene == "Scene1001" else [237, 325]},
                            "stateHandler": {**engine[0], "lines": [341, 463]} if scene == "Scene1002" else
                            {**engine[1], "lines": [217, 245]},
                            "manifestSHA256": original_record["sha256"], "runtimeSHA256": runtime_record["sha256"],
                            "entry": deepcopy(entry), "job": deepcopy(job)}
                identity.update(scene=scene, stateRules=deepcopy(rules), background=background_identity,
                                inputHashes={"manifest": original_record["sha256"], "runtime": runtime_record["sha256"],
                                             "code": {Path(item["path"]).name: item["sha256"] for item in code + engine}})
                context_hash = pilot.digest(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode())
                identifier = f"{scene}-{resource}-{context_hash}"
                kind = "foreground-occluder" if resource in OCCLUDERS else "static-prop"
                blocked = ["missing-restored-state-RGB"] if resource == "15288120" else []
                asset.update(id=identifier, kind=kind)
                if kind == "foreground-occluder":
                    asset["backgroundCorrespondence"] = "explicit-scene-binding"
                    # The core diagnostic accepts RGB only; retain RGBA originals at catalog level.
                    with Image.open(background_path) as image:
                        if image.mode == "RGB":
                            asset["originalBackgroundPath"] = str(background_path)
                with Image.open(asset["sourcePath"]) as image:
                    rgba = np.asarray(image)
                x, y = asset["placement"]
                width, height = asset["contentSize"]
                if x < 0 or y < 0 or x + width > 640 or y + height > 480:
                    raise ValueError("Static source placement is outside its scene")
                delta = np.abs(rgba[:, :, :3].astype(np.int16) -
                               background_rgb[y:y + height, x:x + width].astype(np.int16))[rgba[:, :, 3] == 255]
                if not delta.size:
                    raise ValueError("Static source is entirely transparent")
                assets.append({"id": identifier, "scene": scene, "resource": resource, "asset": asset,
                               "bindingStatus": "verified", "processingStatus": "blocked" if blocked else "eligible",
                               "blockedReasons": blocked, "kind": kind, "sourceEvidence": evidence,
                               "stateRules": rules, "backgroundResource": palette_resource,
                               "backgroundSourcePath": str(background_path), "backgroundSourceSHA256": background_record["sha256"],
                               "backgroundSourceIdentity": background_identity,
                               "sourceOriginalBackgroundVisibleRGB": {
                                   "exactMatch": bool(np.all(delta == 0)), "meanAbsoluteError": float(delta.mean()),
                                   "maxAbsoluteError": int(delta.max()),
                                   "interpretation": "Diagnostic only, not crop correspondence approval or restored-state RGB."},
                               "approvalStatus": "review-required", "runtimePromotion": False})
    return {"schemaVersion": 1, "sourceBinding": binding, "files": files, "assets": assets,
            "scopeLimits": ["Only the thirteen declared prepared Scene1001/Scene1002 static frame-zero unflipped bindings; not all game assets.",
                            "Held animation 004a4495 is excluded, as are all other animated, flipped and unprepared contexts.",
                            "Eligibility is source-bound candidate context only, not RGB correspondence or gameplay approval.",
                            "Activation-only button 15288120 requires restored-state RGB; never substitute the base background crop.",
                            "Engine visibility, clipping, priority and state transitions remain unchanged. No selected restored background is chosen here.",
                            "Read-only metadata and byte verification; no file writes, API calls or runtime promotion."]}
