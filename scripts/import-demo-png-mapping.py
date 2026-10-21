import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile

from PIL import Image


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    if path.resolve() != path.absolute() or not path.is_file():
        raise ValueError("Expected a regular nonsymlink input")
    return path.read_bytes()


def import_mapping(root, mapping, rooms, output):
    root = root.resolve()
    private = root / "private-assets"
    output = output.absolute()
    if (not mapping.resolve().is_relative_to(private)
            or not output.is_relative_to(private) or output == private
            or output.parent.resolve() != output.parent or output.exists()):
        raise ValueError("Use an existing private mapping and a new private output")
    previous = regular(mapping)
    table = json.loads(previous)
    if table.get("version") != 1 or not table.get("private"):
        raise ValueError("Unsupported original-to-HD table")
    stage = Path(tempfile.mkdtemp(prefix=output.name + ".preparing-", dir=output.parent))
    evidence = []
    try:
        (stage / "images").mkdir()
        for directory in rooms:
            source_bytes = regular(directory / "room-pack.json")
            source = json.loads(source_bytes)
            room = source.get("room")
            if (source.get("version") != 1 or room not in ("Scene1001", "Scene1002")
                    or source.get("runtimeSHA256") != table["runtimeSHA256"]
                    or source.get("private") is not True or source.get("scale") != 4):
                raise ValueError("Expected an existing working PNG room pack")
            pack = {**source, "version": 2, "lossless": True,
                    "images": [], "entries": [], "backgrounds": []}
            resources = {}
            for field in ("entries", "backgrounds"):
                for original in source.get(field, []):
                    relative = Path(original["file"])
                    if (relative.is_absolute() or ".." in relative.parts
                            or "\\" in original["file"]):
                        raise ValueError("Unsafe PNG member")
                    data = regular(directory / relative)
                    if digest(data) != original["sha256"]:
                        raise ValueError("Working PNG SHA256 mismatch")
                    with Image.open(io.BytesIO(data)) as image:
                        if image.format != "PNG" or image.size != (original["width"], original["height"]):
                            raise ValueError("Working PNG geometry mismatch")
                        profile = image.info.get("icc_profile")
                        full = image.convert("RGBA")
                        box = full.getchannel("A").getbbox() or (0, 0, 1, 1)
                        cropped = full.crop(box)
                    normal = cropped.tobytes()
                    mirrored = cropped.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
                    prefix = struct.pack(">II", *cropped.size)
                    flip = field != "backgrounds" and digest(prefix + mirrored.tobytes()) < digest(prefix + normal)
                    canonical = mirrored if flip else cropped
                    encoded = io.BytesIO()
                    canonical.save(encoded, "PNG", compress_level=6, icc_profile=profile)
                    png = encoded.getvalue()
                    with Image.open(io.BytesIO(png)) as check:
                        if check.convert("RGBA").tobytes() != canonical.tobytes():
                            raise ValueError("Lossless PNG round-trip mismatch")
                    recovered = canonical.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if flip else canonical
                    if recovered.tobytes() != normal:
                        raise ValueError("Lossless mirror round-trip mismatch")
                    identifier = digest(png)
                    file = f"images/{identifier}.png"
                    if identifier not in resources:
                        resources[identifier] = {"id": identifier, "file": file, "format": "png",
                                                 "sha256": identifier, "width": canonical.width, "height": canonical.height}
                        destination = stage / file
                        if not destination.exists():
                            destination.write_bytes(png)
                        table["images"][identifier] = {"sha256": identifier,
                            "sourceFile": str((output / file).relative_to(root)), "bytes": len(png),
                            "width": canonical.width, "height": canonical.height}
                    binding = {key: value for key, value in original.items() if key not in ("file", "sha256", "crop", "format")}
                    binding.update(image=identifier, flipX=flip,
                                   crop={"x": box[0], "y": box[1], "width": canonical.width, "height": canonical.height})
                    pack[field].append(binding)
                    table["originals"].append({"room": room, "key": original["key"],
                        "resource": original.get("resource"), "frameId": original.get("frameId"),
                        "indexedSHA256": original.get("sourceSHA256"), "image": identifier,
                        "workingPNG": original["sha256"], "provenance": "existing-working-demo-lossless-PNG"})
            pack["images"] = list(resources.values())
            keys = list(dict.fromkeys(row["key"] for row in pack["backgrounds"]))
            if not keys:
                raise ValueError("Working room has no background trigger")
            table["rooms"] = [row for row in table["rooms"] if row["id"] != room
                              and not set(row["backgroundKeys"]).intersection(keys)]
            table["rooms"].insert(0, {"id": room, "aliases": [room], "backgroundKeys": keys,
                "manifest": pack, "coverage": {"complete": False, "source": "existing-working-demo-lossless-PNG"}})
            evidence.append({"room": room, "manifestSHA256": digest(source_bytes), "images": len(resources),
                "transform": "alpha bounds and reversible horizontal mirror; lossless PNG",
                "decodedRGBARoundTrip": True})
        table["provenance"] = {**table["provenance"], "previousAssetMapSHA256": digest(previous), "workingDemoRooms": evidence}
        encoded_table = (json.dumps(table, separators=(",", ":")) + "\n").encode()
        (stage / "asset-map.json").write_bytes(encoded_table)
        if output.exists():
            raise FileExistsError(output)
        stage.rename(output)
        return {"rooms": len(table["rooms"]), "assetMapSHA256": digest(encoded_table), "workingDemoRooms": evidence}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--room", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(import_mapping(args.root, args.mapping, args.room, args.output), indent=2))
