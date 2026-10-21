import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

spec = importlib.util.spec_from_file_location("demo_png_mapping", Path(__file__).resolve().parents[1] / "scripts/import-demo-png-mapping.py")
mapping_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mapping_tool)


class PNGMappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/tmp/kilo")
        self.root = Path(self.temp.name)
        self.private = self.root / "private-assets"
        self.private.mkdir()
        self.mapping = self.private / "input.json"
        self.mapping.write_text(json.dumps({"version": 1, "private": True, "runtimeSHA256": "a" * 64,
            "provenance": {}, "images": {}, "originals": [], "rooms": []}))
        self.room = self.root / "working"
        self.room.mkdir()
        sprite = Image.new("RGBA", (16, 8), (11, 22, 33, 0))
        for y in range(2, 6):
            for x in range(4, 12):
                sprite.putpixel((x, y), (x * 17, y * 19, x * y, 255))
        self.sprite = sprite
        sprite.save(self.room / "sprite.png")
        Image.new("RGBA", (2560, 1920), (20, 30, 40, 255)).save(self.room / "background.png")
        def entry(name, width, height, key):
            return {"file": name, "sha256": hashlib.sha256((self.room / name).read_bytes()).hexdigest(),
                    "width": width, "height": height, "key": key, "scale": 4}
        self.manifest = {"version": 1, "private": True, "room": "Scene1001", "scale": 4, "runtimeSHA256": "a" * 64,
            "sourceBinding": "existing-working-demo",
            "entries": [{**entry("sprite.png", 16, 8, "4x2-4-11111111-p22222222-0"), "kind": "sprite"}],
            "backgrounds": [{**entry("background.png", 2560, 1920, "640x480-640-33333333-p22222222-opaque"), "id": "gemini"}]}
        (self.room / "room-pack.json").write_text(json.dumps(self.manifest))
        self.output = self.private / "output"

    def tearDown(self):
        self.temp.cleanup()

    def test_lossless_crop_and_reversible_flip_preserve_every_cropped_rgba_byte(self):
        original = (self.room / "sprite.png").read_bytes()
        report = mapping_tool.import_mapping(self.root, self.mapping, [self.room], self.output)
        table = json.loads((self.output / "asset-map.json").read_text())
        binding = table["rooms"][0]["manifest"]["entries"][0]
        self.assertEqual(binding["key"], self.manifest["entries"][0]["key"])
        self.assertEqual(binding["crop"], {"x": 4, "y": 2, "width": 8, "height": 4})
        image = table["images"][binding["image"]]
        path = self.root / image["sourceFile"]
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), image["sha256"])
        with Image.open(path) as result:
            result = result.convert("RGBA")
            if binding["flipX"]:
                result = result.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            self.assertEqual(result.tobytes(), self.sprite.crop((4, 2, 12, 6)).tobytes())
        self.assertEqual((self.room / "sprite.png").read_bytes(), original)
        self.assertTrue(report["workingDemoRooms"][0]["decodedRGBARoundTrip"])
        with self.assertRaises(ValueError):
            mapping_tool.import_mapping(self.root, self.mapping, [self.room], self.output)

    def test_changed_working_png_is_rejected_without_publishing_a_table(self):
        (self.room / "sprite.png").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "SHA256"):
            mapping_tool.import_mapping(self.root, self.mapping, [self.room], self.output)
        self.assertFalse(self.output.exists())

    def test_outside_output_and_symlink_source_are_rejected(self):
        with self.assertRaises(ValueError):
            mapping_tool.import_mapping(self.root, self.mapping, [self.room], self.root / "outside")
        original = self.room / "sprite.png"
        original.rename(self.room / "actual.png")
        original.symlink_to(self.room / "actual.png")
        with self.assertRaises(ValueError):
            mapping_tool.import_mapping(self.root, self.mapping, [self.room], self.output)


if __name__ == "__main__":
    unittest.main()
