#!/usr/bin/env python3
"""Build a private, offline-capable comparison page from curated visual rankings."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
EXPERIMENTS = ROOT / "private-assets/upscaling/gemini-experiments"
RUNS = ("static-pilot-v1-2096d1751ccd", "static-text-material-v1-de63d3465dda")
PROFILES = Path(__file__).with_name("object-regions.json")


def build(rankings_path, output_dir, run_dirs=None):
    rankings = json.loads(Path(rankings_path).read_text(encoding="utf-8"))
    if rankings.get("schemaVersion") != 1:
        raise ValueError("Invalid ranking version")
    output_dir = Path(output_dir)
    assets = output_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    profiles = json.loads(PROFILES.read_text(encoding="utf-8"))["rooms"]
    evaluations = [json.loads((Path(directory) / "eval.json").read_text(encoding="utf-8"))
                   for directory in (run_dirs or [EXPERIMENTS / name for name in RUNS])]
    candidates = {}
    room_entries = {}
    for evaluation in evaluations:
        if evaluation.get("evaluationPolicy", {}).get("primary") != "object-first":
            raise ValueError("Object-first evaluations required")
        for room in evaluation["rooms"]:
            room_entries.setdefault(room["id"], room["entries"])
            for entry in room["entries"]:
                if entry["kind"] == "candidate":
                    if entry["id"] in candidates:
                        raise ValueError("Duplicate candidate")
                    candidates[entry["id"]] = (room["id"], entry)

    def pack(entry, identifier, title, room_id, extra=None):
        source = Path(entry["path"])
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != entry.get("sha256"):
            raise ValueError("Stale image: " + identifier)
        native = assets / (digest + source.suffix.lower())
        if not native.exists():
            shutil.copyfile(source, native)
        with Image.open(source) as opened:
            image = opened.convert("RGB")
        preview = assets / (digest + "-preview.webp")
        thumbnail = image.copy()
        thumbnail.thumbnail((960, 720), Image.Resampling.LANCZOS)
        thumbnail.save(preview, quality=94)
        crops = {}
        for region in profiles[room_id]:
            box = region["box"]
            bounds = (int(box[0] * image.width), int(box[1] * image.height),
                      max(int(box[0] * image.width) + 1, int(box[2] * image.width)),
                      max(int(box[1] * image.height) + 1, int(box[3] * image.height)))
            crop = image.crop(bounds)
            scale = 768 / max(crop.size)
            crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
            crop_path = assets / (digest + "-" + region["id"] + ".png")
            crop.save(crop_path)
            crops[region["id"]] = "assets/" + crop_path.name
        return {"id": identifier, "title": title, "src": "assets/" + native.name,
                "preview": "assets/" + preview.name, "width": image.width, "height": image.height,
                "sha256": digest, "crops": crops, **(extra or {})}

    rooms = []
    selected_ids = set()
    for room in rankings["rooms"]:
        room_id = room["id"]
        if room_id not in profiles:
            raise ValueError("No registered regions for " + room_id)
        entries = room_entries[room_id]
        original = next(entry for entry in entries if entry["kind"] == "source")
        baseline = next(entry for entry in entries if entry.get("control") == "Existing Gemini baseline")
        items = [pack(original, room_id + "-original", "Оригинал 640 × 480", room_id,
                      {"kind": "source", "note": "Единственный эталон состава сцены и геометрии."}),
                 pack(baseline, room_id + "-demo", "Текущий фон демо", room_id,
                      {"kind": "baseline", "note": "Вне рейтинга: контроль для сравнения. Объектный eval для этого файла не выполнялся."})]
        for rank, choice in enumerate(room["ranking"], start=1):
            if choice["id"] in selected_ids:
                raise ValueError("Duplicate ranked candidate")
            selected_ids.add(choice["id"])
            candidate_room, entry = candidates[choice["id"]]
            if candidate_room != room_id or entry.get("decision", {}).get("verdict") != "no-structural-change-detected":
                raise ValueError("Cannot rank a rejected, uncertain or unevaluated candidate")
            items.append(pack(entry, choice["id"], choice["title"], room_id, {
                "kind": "candidate", "rank": rank, "note": choice["reason"], "tradeoff": choice["tradeoff"],
                "model": entry["model"], "promptVariant": entry["promptVariant"], "referenceMode": entry["referenceMode"],
                "structuralStatus": entry["decision"]["verdict"],
            }))
        if len(room["ranking"]) != 3:
            raise ValueError("Exactly three visually ranked candidates per room required")
        rooms.append({**room, "items": items, "regions": profiles[room_id]})

    rejected = []
    for identifier, (room_id, entry) in candidates.items():
        if entry.get("decision", {}).get("verdict") == "reject":
            rejected.append(pack(entry, identifier, identifier, room_id, {
                "roomId": room_id, "reasons": entry["decision"]["reasons"],
                "reviewNote": rankings.get("rejectionNotes", {}).get(identifier, (entry["decision"]["reasons"] or ["Структурное изменение"])[0]),
            }))
    payload = {"rooms": rooms, "rejected": rejected, "totalEvaluated": len(candidates),
               "ranked": len(selected_ids), "scope": "static-backgrounds-only", "rankingBasis": "subjective-visual-no-pixel-ranking"}
    serialized = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    template = Path(__file__).with_name("comparison.html").read_text(encoding="utf-8")
    page = template.replace("__COMPARISON_DATA__", serialized)
    (output_dir / "index.html").write_text(page, encoding="utf-8")
    (output_dir / "comparison-data.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rankings", type=Path, default=ROOT / "private-assets/upscaling/gemini-comparison/ranking.json")
    parser.add_argument("--output", type=Path, default=ROOT / "private-assets/upscaling/gemini-comparison")
    args = parser.parse_args()
    data = build(args.rankings, args.output)
    print(json.dumps({"page": str(args.output / "index.html"), "ranked": data["ranked"], "rejected": len(data["rejected"])}, ensure_ascii=False))
