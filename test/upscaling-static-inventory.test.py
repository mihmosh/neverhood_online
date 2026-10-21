"""Offline source candidate scanning, with no asset/catalog mutation."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tools/upscaling/static/source_inventory.py'
SPEC = importlib.util.spec_from_file_location('source_inventory', SCRIPT)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class SourceInventoryTests(unittest.TestCase):
    def scan(self, cpp, header=''):
        return inventory.scan_texts({'scene.cpp': cpp, 'sprites.h': header})

    def test_comments_strings_raw_strings_and_line_offsets(self):
        cpp = '''// insertStaticSprite(0xBAD, 1);
/* insertStaticSprite(0xBAD, 2);
   still a comment */
Scene::Scene() {
 const char *s = "insertStaticSprite(0xBAD, 3); //";
 const char *r = R"tag(insertStaticSprite(0xBAD, 4);)tag";
 insertStaticSprite(0xAABBCCDDu, 100);
}
'''
        result = self.scan(cpp)
        self.assertEqual(len(result['uses']), 1)
        use = result['uses'][0]
        self.assertEqual((use['resource'], use['line']), ('aabbccdd', 7))
        self.assertEqual(use['function'], 'Scene::Scene')
        self.assertEqual(use['sourceSHA256'], hashlib.sha256(cpp.encode()).hexdigest())
        self.assertEqual(len(inventory.lexical_mask(cpp)), len(cpp))

    def test_balanced_arguments_arrays_and_dynamic_expressions(self):
        cpp = '''Scene::Scene() {
 insertStaticSprite(pick(1, table[index(2, 3)]), priority(4, 5));
 insertStaticSprite(flag ? 0x123 : 0x456, 12);
 insertStaticSprite(hashes[index], 13);
 insertStaticSprite(0X1234UL /* resource */, 14);
}'''
        uses = self.scan(cpp)['uses']
        self.assertEqual(uses[0]['arguments'], ['pick(1, table[index(2, 3)])', 'priority(4, 5)'])
        self.assertTrue(all(use['resource'] is None for use in uses[:3]))
        self.assertEqual(uses[3]['resource'], '00001234')
        self.assertTrue(all(use['reviewBlocked'] for use in uses))

    def test_escaped_line_comments_and_template_call_arguments(self):
        cpp = ('// continued comment \\\n'
               'insertStaticSprite(0xBAD, 1);\n'
               'Scene::Scene() {\n'
               'insertStaticSprite(select<std::pair<int, int>>(one, two), 100);\n'
               'insertStaticSprite(x < y ? one : two, 200);\n'
               '}')
        uses = self.scan(cpp)['uses']
        self.assertEqual(len(uses), 2)
        self.assertEqual(uses[0]['arguments'], ['select<std::pair<int, int>>(one, two)', '100'])
        self.assertEqual(uses[1]['arguments'], ['x < y ? one : two', '200'])

    def test_transitive_inheritance_and_no_actor_loads(self):
        header = '''class Sprite {};
class AnimatedSprite : public Sprite {};
class StaticSprite : public Sprite {};
class Button : public StaticSprite {};
class Derived : public Button {};
class Actor : public AnimatedSprite {};'''
        cpp = '''Actor::Actor() { loadSprite(0xBAD, 0); }
Derived::Derived() : Button(vm, hashes[index]) {
 loadSprite(0x123, flags, priority);
 this->loadSprite(dynamicHash, 0);
 _actor->loadSprite(0xBAD, 0);
}
Scene::Scene() {
 insertSprite<Derived>(this, 0x456);
 insertSprite<Actor>();
 insertSprite<UnknownHelper>(table[index]);
 new StaticSprite(vm, 0xABC, 12);
 new Derived(vm, 0xDEF);
 new Actor(vm);
}'''
        result = self.scan(cpp, header)
        uses = result['uses']
        loads = [use for use in uses if use['pattern'] == 'loadSprite']
        self.assertEqual([use['resource'] for use in loads], ['00000123', None])
        derived = [use for use in uses if use['targetClass'] == 'Derived']
        self.assertEqual(len(derived), 2)
        self.assertTrue(all(use['resource'] is None and use['staticClassProven'] for use in derived))
        self.assertEqual(next(use for use in uses if use['targetClass'] == 'StaticSprite')['resource'], '00000abc')
        unknown = next(use for use in uses if use['targetClass'] == 'UnknownHelper')
        self.assertIn('unrecognized-class-inheritance', unknown['reviewReasons'])
        coverage = result['coverage']
        self.assertEqual(coverage['rawCallsByPattern']['loadSprite'], 4)
        self.assertEqual(coverage['excludedCounts']['knownNonStaticClass'], 2)
        self.assertFalse(coverage['completeGameClosure'])

    def test_base_constructor_resource_and_method_local_evidence(self):
        cpp = '''Button::Button(VM *vm, uint32 hash)
 : StaticSprite(vm, 0x12, 100), _value{2} {
 setPosition(4, 5);
 _palette->addPalette(0x123);
 setDoDeltaX(1);
 setClipRect(rect);
}
void Button::change() {
 loadSprite(hashes[state], flags);
}
Scene::Scene() { insertStaticSprite(0x99, 1); }
void OtherScene::setup() { _palette->addPalette(0xBAD); }
'''
        result = self.scan(cpp, 'class Button : public StaticSprite {};')
        base = next(use for use in result['uses'] if use['pattern'] == 'staticBaseInitializer')
        self.assertEqual(base['resource'], '00000012')
        self.assertEqual(len(base['geometryOperations']), 3)
        self.assertEqual(len(base['paletteOperations']), 1)
        self.assertIn('_value{2}', base['constructorStateExcerpt'])
        load = next(use for use in result['uses'] if use['pattern'] == 'loadSprite')
        self.assertEqual(load['function'], 'Button::change')
        self.assertEqual(load['paletteOperations'], [])
        scene = next(use for use in result['uses'] if use['pattern'] == 'insertStaticSprite')
        self.assertNotIn('OtherScene', scene['stateContext']['excerpt'])
        self.assertEqual(scene['paletteOperations'], [])

    def test_definition_is_not_a_call_and_coverage_reconciles(self):
        cpp = '''Sprite *Scene::insertStaticSprite(uint32 hash, int priority) {
 return addSprite(new StaticSprite(vm, hash, priority));
}
void StaticSprite::loadSprite(uint32 hash, uint flags) {}
'''
        result = self.scan(cpp)
        self.assertEqual(len(result['uses']), 1)
        coverage = result['coverage']
        self.assertEqual(coverage['rawCallCount'], coverage['candidateCount'] + sum(coverage['excludedCounts'].values()))
        self.assertEqual(coverage['excludedCounts']['methodDefinition'], 2)

    def test_no_resource_coercion_or_class_prefix_inference(self):
        result = self.scan('''Scene::Scene() {
 insertSprite<AsMystery>(0x123);
 insertStaticSprite(0x100000000, 1);
 insertStaticSprite(-1, 1);
 insertStaticSprite("0x123", 1);
}''')
        self.assertTrue(all(use['resource'] is None for use in result['uses']))
        self.assertFalse(result['uses'][0]['staticClassProven'])

    def test_static_constructor_priority_is_not_a_resource(self):
        cpp = '''Button::Button(VM *vm) : StaticSprite(vm, 1100) {
 loadSprite(0xAABBCCDD, 0);
}
Scene::Scene() { new StaticSprite(vm, 100); }'''
        result = self.scan(cpp, 'class Button : public StaticSprite {};')
        self.assertEqual([use['resource'] for use in result['uses']], [None, 'aabbccdd', None])
        for use in (result['uses'][0], result['uses'][2]):
            self.assertIn('static-constructor-object-priority-overload-has-no-resource', use['reviewReasons'])

    def test_unknown_inherited_helpers_remain_review_blocked(self):
        header = '''class Helper : public MissingBase {};
class Templated : public UnknownBase<int> {};
class Duplicate : public StaticSprite {};
class Duplicate : public AnimatedSprite {};'''
        result = self.scan('''Scene::Scene() {
 insertSprite<Helper>(hashes[i]);
 insertSprite<Templated>();
 insertSprite<Duplicate>();
}''', header)
        self.assertEqual(len(result['uses']), 3)
        self.assertTrue(all(not use['staticClassProven'] and use['reviewBlocked'] for use in result['uses']))

    def test_scan_source_hashes_all_files_and_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'scummvm/engines/neverhood'
            (source / 'modules').mkdir(parents=True)
            (source / 'sprite.cpp').write_text('void StaticSprite::f() {}\n')
            (source / 'classes.h').write_text('class Button : public StaticSprite {};\n')
            (source / 'modules/scene.cpp').write_text('Scene::Scene() { insertStaticSprite(0xABC, 1); }\n')
            before = {path: path.read_bytes() for path in root.rglob('*') if path.is_file()}
            result = inventory.scan_source(root)
            self.assertEqual(result['coverage']['cppFilesScanned'], 2)
            self.assertEqual(result['coverage']['headerFilesScanned'], 1)
            self.assertEqual(result['uses'][0]['resource'], '00000abc')
            self.assertEqual(before, {path: path.read_bytes() for path in root.rglob('*') if path.is_file()})

    def test_cli_requires_explicit_private_output(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        for path in (ROOT / 'web/public/index.json', ROOT / 'dist/index.json', ROOT / 'index.json',
                     Path('/tmp/not-private.json'), ROOT / 'private-assets/public/index.json'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                inventory.private_output(path)
        self.assertEqual(inventory.private_output('/tmp/kilo/inventory.json'), Path('/tmp/kilo/inventory.json').resolve())

    def test_cli_writes_json_only_and_never_overwrites(self):
        with tempfile.TemporaryDirectory(dir='/tmp/kilo') as directory:
            root = Path(directory)
            (root / 'sprite.cpp').write_text('Scene::Scene() { insertStaticSprite(0x123, 1); }')
            output = root / 'result.json'
            command = [sys.executable, str(SCRIPT), '--root', str(root), '--output', str(output)]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual((first.stdout, first.stderr), ('', ''))
            original = output.read_bytes()
            self.assertEqual(json.loads(original)['uses'][0]['resource'], '00000123')
            second = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(second.stdout, '')
            self.assertEqual(output.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
