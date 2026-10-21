#!/usr/bin/env python3
"""Offline fixtures for conservative source-bound static candidate resolution."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools/upscaling/static'))
import resolve
import source_inventory


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/tmp/kilo')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = self.root / 'private-assets'
        self.catalog.mkdir()
        (self.catalog / 'manifest.json').write_text(json.dumps({'sourceBinding': 'fixture-game'}))
        self.code_path = 'scummvm/engines/neverhood/modules/module9000.cpp'
        code = self.root / self.code_path
        code.parent.mkdir(parents=True)
        for name in ('scene.cpp', 'sprite.cpp'):
            (code.parent.parent / name).write_text('// fixture constructor semantics\n')
        self.code = '''Scene9000::Scene9000() {
    setBackground(0x12345678);
    setPalette(0x12345678);
    insertStaticSprite(0xabcdef01, 1100);
}
'''
        self.set_code(self.code)
        self.db = sqlite3.connect(self.catalog / 'catalog.sqlite')
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE resources(id TEXT,format TEXT);
            CREATE TABLE decodedframes(id TEXT,resource_id TEXT,requested_hash INTEGER,
                list_index INTEGER,frame_index INTEGER,width INTEGER,height INTEGER,
                indexed_blob TEXT,metadata_json TEXT);
            CREATE TABLE blobs(sha256 TEXT,path TEXT,size INTEGER);
            CREATE TABLE palettes(resource_id TEXT,blob TEXT);
            CREATE TABLE aliases(resolved_id TEXT,requested_hash INTEGER);
        ''')
        palette = np.zeros((256, 4), np.uint8)
        palette[:, 3] = 255
        palette[1, :3] = [45, 85, 123]
        palette[2, :3] = [200, 130, 60]
        self.palette = self.add_blob(palette.tobytes(), 'palette')
        self.indices = np.array([[1, 0, 2], [2, 1, 1]], np.uint8)
        self.sprite = self.add_blob(self.indices.tobytes(), 'sprite')
        bg = np.ones((480, 640), np.uint8)
        bg[7:9, 5:8] = self.indices
        self.background = self.add_blob(bg.tobytes(), 'background')
        for identifier, resource, width, height, blob, metadata in (
                ('sprite', 0xabcdef01, 3, 2, self.sprite, {'x': 5, 'y': 7}),
                ('background', 0x12345678, 640, 480, self.background, {'x': 0, 'y': 0})):
            self.db.execute('INSERT INTO resources VALUES (?,?)', (identifier, 'bitmap'))
            self.db.execute('INSERT INTO decodedframes VALUES (?,?,?,?,?,?,?,?,?)',
                            (identifier, identifier, resource, 0, 0, width, height, blob['sha256'], json.dumps(metadata)))
        self.db.execute('INSERT INTO palettes VALUES (?,?)', ('background', self.palette['sha256']))
        self.db.execute('INSERT INTO aliases VALUES (?,?)', ('background', 0x12345678))
        self.db.commit()
        source = self.catalog / 'original.png'
        Image.fromarray(palette[bg, :3]).save(source)
        donor = self.catalog / 'donor.png'
        Image.new('RGB', (1280, 960), (45, 85, 123)).save(donor)
        self.room = {'id': 'Scene9000', 'metadata': {
            'id': 'Scene9000', 'resourceId': '0x12345678', 'source': self.record(source),
            'provenance': {'catalogSourceBinding': 'fixture-game', 'decodedFrameId': 'background',
                           'indexedPixels': self.background, 'palette': self.palette,
                           'codeBinding': self.record(self.root / self.code_path)}},
            'entries': [{'observedStatus': 'succeeded', 'technicalStatus': 'technical-valid',
                         'status': 'heuristic-review-flag',
                         'output': {**self.record(donor), 'dimensions': [1280, 960], 'opaque': True}}]}

    def record(self, path):
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def add_blob(self, data, name):
        path = self.catalog / (name + '.bin')
        path.write_bytes(data)
        record = self.record(path)
        self.db.execute('INSERT INTO blobs VALUES (?,?,?)',
                        (record['sha256'], path.name, len(data)))
        return record

    def set_code(self, code):
        (self.root / self.code_path).write_text(code)
        self.inventory = source_inventory.scan_texts({self.code_path: code})
        if hasattr(self, 'room'):
            self.room['metadata']['provenance']['codeBinding'] = self.record(self.root / self.code_path)

    def run_resolver(self, prepared=None, rooms=None):
        return resolve.resolve_candidates(self.root, self.catalog, self.inventory,
                                          {'rooms': [self.room] if rooms is None else rooms},
                                          prepared or [], self.root / 'private-assets/resolved')

    def assert_blocked(self, reason):
        entries = self.run_resolver()
        self.assertTrue(entries)
        self.assertEqual(entries[0]['processingStatus'], 'blocked')
        self.assertIn(reason, entries[0]['blockedReasons'])
        self.assertNotIn('asset', entries[0])
        return entries

    def test_exact_rgb_match_generates_verified_native_source(self):
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertFalse(entry['automaticApproval'])
        self.assertEqual(entry['backgroundRef'], self.room)
        asset = entry['asset']
        self.assertEqual(asset['contentSize'], [3, 2])
        self.assertEqual(asset['canvasSize'], [4, 2])
        self.assertEqual(asset['placement'], [5, 7])
        with Image.open(asset['sourcePath']) as source:
            self.assertEqual(source.mode, 'RGBA')
            self.assertEqual(source.getpixel((1, 0))[3], 0)
            self.assertEqual(source.getpixel((0, 0)), (45, 85, 123, 255))
        self.assertEqual(self.record(Path(asset['sourcePath']))['sha256'], asset['sourceSHA256'])
        self.assertEqual(asset['sourceIdentity']['initialPriority'], 1100)
        self.assertEqual(asset['sourceIdentity']['transparentIndex'], 0)
        self.assertEqual(self.run_resolver()[0]['asset'], asset)

    def test_changed_state_rgb_requires_independent_donor(self):
        indices = self.indices.copy()
        indices[0, 0] = 2
        changed = self.add_blob(indices.tobytes(), 'changed-sprite')
        self.db.execute('UPDATE decodedframes SET indexed_blob=? WHERE id=?', (changed['sha256'], 'sprite'))
        self.db.commit()
        self.assert_blocked('independent-or-state-RGB-required')

    def test_multiple_or_unknown_palette_operations_block(self):
        for operation in ('setPalette(0x98765432);', '_palette->addPalette(0x12345678, 0, 1);',
                          '_palette->fillBaseWhite(0, 2);', 'setPalette(dynamicHash);'):
            with self.subTest(operation=operation):
                self.set_code(self.code + '\nvoid Scene9000::update() { ' + operation + ' }\n')
                self.assert_blocked('palette-state-context-unproven')

    def test_position_flip_visibility_and_reload_block(self):
        for operation in ('sprite->setPosition(6, 7);', 'sprite->setDoDeltaX(1);',
                          'sprite->setVisible(false);', 'sprite->loadSprite(0xabcdef01);'):
            with self.subTest(operation=operation):
                self.set_code(self.code.replace('insertStaticSprite', 'sprite = insertStaticSprite')
                              + '\nvoid Scene9000::update() { ' + operation + ' }\n')
                self.assert_blocked('target-geometry-or-state-context-unproven')

    def test_animation_format_is_not_static_bitmap(self):
        self.db.execute("UPDATE resources SET format='animation' WHERE id='sprite'")
        self.db.commit()
        self.assert_blocked('non-bitmap-resource-format')

    def test_metadata_and_catalog_blob_hash_corruption_block(self):
        self.room['metadata']['source']['sha256'] = '0' * 64
        self.assert_blocked('metadata-hash-integrity-failure')
        self.room['metadata']['source'] = self.record(self.catalog / 'original.png')
        (self.catalog / 'sprite.bin').write_bytes(b'bad')
        self.assert_blocked('Decoded catalog blob integrity failure')

    def test_donor_metadata_and_technical_failure_are_not_autoapproved(self):
        donor = self.room['entries'][0]
        donor['technicalStatus'] = 'hard-technical-failure'
        entry, = self.assert_blocked('background-upstream-technical-failure')
        self.assertEqual(entry['backgroundRef']['entries'][0]['technicalStatus'], 'hard-technical-failure')
        donor['technicalStatus'] = 'technical-valid'
        donor['output']['sha256'] = '0' * 64
        self.assert_blocked('metadata-hash-integrity-failure')

    def test_multiple_background_states_are_retained_blocked(self):
        second = deepcopy(self.room)
        second['id'] = 'Scene9000-state2'
        entry, = self.run_resolver(rooms=[self.room, second])
        self.assertEqual(entry['blockedReasons'], ['missing-or-ambiguous-scene-background-context'])

    def test_unresolved_and_module_contexts_are_not_dropped(self):
        self.set_code('''Module9000::Module9000() { insertStaticSprite(0xabcdef01, 1100); }
Scene9000::Scene9000() { insertStaticSprite(dynamicHash, 1100); }
void Scene9000::update() { insertStaticSprite(0xabcdef01, 1100); }
''')
        entries = self.run_resolver()
        self.assertEqual(len(entries), 3)
        self.assertTrue(all(entry['processingStatus'] == 'blocked' for entry in entries))
        self.assertEqual(sum(entry['resource'] is None for entry in entries), 1)

    def test_conditional_direct_site_retains_evidence_not_state_approval(self):
        self.set_code(self.code.replace('insertStaticSprite', 'if (pressed) insertStaticSprite'))
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertEqual(entry['statePredicateResolution'], 'source-evidence-only')
        self.assertIn('if (pressed)', entry['sourceEvidence']['stateContext']['excerpt'])
        self.assertIn('if (pressed)', entry['asset']['sourceIdentity']['stateContext']['excerpt'])
        self.assertFalse(entry['runtimePromotion'])

    def test_unrelated_helper_is_review_only_but_inherited_scene_is_unproven(self):
        self.set_code(self.code + '\nvoid Scene9000::update() { mutateSprite(); }\n')
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertTrue(entry['reviewFlags'])
        self.set_code(self.code)
        header_path = 'scummvm/engines/neverhood/modules/module9000.h'
        header = 'class Scene9000 : public Scene8000 { void update(); };\n'
        (self.root / header_path).write_text(header)
        self.inventory = source_inventory.scan_texts({self.code_path: self.code, header_path: header})
        self.assert_blocked('inherited-or-ambiguous-scene-context')
        header = 'class Scene9000 : public Scene { void update() { mutateSprite(); } };\n'
        (self.root / header_path).write_text(header)
        self.inventory = source_inventory.scan_texts({self.code_path: self.code, header_path: header})
        self.assertEqual(self.run_resolver()[0]['processingStatus'], 'eligible')

    def test_actor_setup_and_entry_conditionals_do_not_mutate_static_target(self):
        actor_setup = '''    if (entry == 1) {
        _klaymen->setPosition(50, 60);
        _klaymen->setClipRect(0, 0, 640, 480);
        configureActor(_klaymen);
    }
'''
        self.set_code(self.code.replace('    insertStaticSprite', actor_setup + '    insertStaticSprite'))
        self.assertEqual(self.run_resolver()[0]['processingStatus'], 'eligible')
        self.set_code(self.code.replace('insertStaticSprite', 'Sprite *ss = insertStaticSprite')
                      .replace('\n}', '\n    _klaymen->setClipRect(ss->getDrawRect());\n}'))
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertEqual(entry['asset']['sourceIdentity']['targetContext']['receiver'], 'ss')
        self.set_code(self.code.replace('insertStaticSprite', 'Sprite *ss = insertStaticSprite')
                      .replace('\n}', '\n    _klaymen->setClipRect(ss->getDrawRect().x, 0, ss->getDrawRect().x2(), 480);\n}'))
        self.assertEqual(self.run_resolver()[0]['processingStatus'], 'eligible')

    def test_local_receiver_lifetime_stops_at_reassignment(self):
        self.set_code(self.code.replace('insertStaticSprite', 'Sprite *ss = insertStaticSprite')
                      .replace('\n}', '\n    ss = _klaymen;\n    ss->setPosition(10, 20);\n}'))
        self.assertEqual(self.run_resolver()[0]['processingStatus'], 'eligible')
        self.set_code(self.code.replace('insertStaticSprite', 'Sprite *ss = insertStaticSprite')
                      .replace('\n}', '\n    ss->setPosition(10, 20);\n    ss = _klaymen;\n}'))
        self.assert_blocked('target-geometry-or-state-context-unproven')
        self.set_code(self.code.replace('insertStaticSprite', 'Sprite *first, *ss; ss = insertStaticSprite')
                      .replace('\n}', '\n    ss = _klaymen;\n    ss->setPosition(10, 20);\n}'))
        self.assertEqual(self.run_resolver()[0]['processingStatus'], 'eligible')

    def test_cast_member_receiver_checks_other_methods_but_not_actors(self):
        self.set_code(self.code.replace('insertStaticSprite', '_sprite = (StaticSprite*)insertStaticSprite')
                      + '\nvoid Scene9000::update() { _klaymen->setPosition(1, 2); }\n')
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertEqual(entry['asset']['sourceIdentity']['targetContext']['scope'], 'scene-member')
        self.set_code(self.code.replace('insertStaticSprite', '_sprite = (StaticSprite*)insertStaticSprite')
                      + '\nvoid Scene9000::update() { _sprite->setVisible(false); }\n')
        self.assert_blocked('target-geometry-or-state-context-unproven')

    def test_paletted_background_is_checked_and_copied_to_private_rgb(self):
        path = self.catalog / 'original.png'
        with Image.open(path) as opened:
            paletted = opened.quantize(colors=256)
        paletted.save(path)
        self.room['metadata']['source'] = self.record(path)
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        asset = entry['asset']
        self.assertNotEqual(str(path), asset['originalBackgroundPath'])
        with Image.open(asset['originalBackgroundPath']) as image:
            self.assertEqual(image.mode, 'RGB')
            self.assertEqual(image.size, (640, 480))
        self.assertEqual(self.record(Path(asset['originalBackgroundPath']))['sha256'],
                         asset['originalBackgroundSHA256'])

    def test_target_alias_escape_and_chained_mutation_block(self):
        for suffix in ('mutate(ss);', 'Sprite *alias = ss;', 'ss->setClipRect(0, 0, 1, 1);',
                       'ss->getDrawRect().x = 10;', 'ss->getDrawRect().set(0, 0, 1, 1);'):
            with self.subTest(suffix=suffix):
                self.set_code(self.code.replace('insertStaticSprite', 'Sprite *ss = insertStaticSprite')
                              .replace('\n}', '\n    ' + suffix + '\n}'))
                self.assertEqual(self.run_resolver()[0]['processingStatus'], 'blocked')
        self.set_code(self.code.replace('insertStaticSprite(0xabcdef01, 1100);',
                                       'insertStaticSprite(0xabcdef01, 1100)->setPosition(10, 20);'))
        self.assert_blocked('static-target-escape-or-chained-operation')

    def test_explicit_actual_scene_alias_does_not_rename_binding(self):
        self.room['metadata']['id'] = 'Module9000'
        self.room['metadata']['bindingAliases'] = [{'scene': 'Scene9000', 'resourceId': '0x12345678'}]
        entry, = self.run_resolver()
        self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertEqual(entry['asset']['sourceIdentity']['scene'], 'Scene9000')
        self.assertEqual(entry['backgroundRef']['metadata']['id'], 'Module9000')

    def test_stale_source_evidence_and_source_binding_block(self):
        self.room['metadata']['provenance']['catalogSourceBinding'] = 'other-game'
        self.assert_blocked('catalog-source-binding-mismatch')
        self.room['metadata']['provenance']['catalogSourceBinding'] = 'fixture-game'
        (self.root / self.code_path).write_text(self.code + '// changed\n')
        self.assert_blocked('metadata-hash-integrity-failure')

    def test_temp_output_is_allowed_and_catalog_remains_read_only(self):
        before = self.record(self.catalog / 'catalog.sqlite')['sha256']
        with tempfile.TemporaryDirectory(dir='/tmp/kilo') as output:
            entry, = resolve.resolve_candidates(self.root, self.catalog, self.inventory,
                                                 {'rooms': [self.room]}, [], Path(output) / 'resolved')
            self.assertEqual(entry['processingStatus'], 'eligible')
        self.assertEqual(before, self.record(self.catalog / 'catalog.sqlite')['sha256'])

    def test_prepared_mapping_requires_exact_scene_resource_and_code(self):
        use, = self.inventory['uses']
        prepared = {'id': 'prepared-binding', 'scene': 'Scene9000', 'resource': 'abcdef01',
                    'sourceEvidence': {'constructor': {**self.record(self.root / self.code_path), 'lines': [1, 5]}}}
        entry, = self.run_resolver([prepared])
        self.assertEqual(entry['processingStatus'], 'mapped-prepared')
        self.assertEqual(entry['preparedBindingIds'], ['prepared-binding'])
        self.assertNotIn('asset', entry)
        prepared['scene'] = 'Scene9001'
        self.assertEqual(self.run_resolver([prepared])[0]['processingStatus'], 'eligible')
        prepared['scene'] = 'Scene9000'
        prepared['sourceEvidence']['constructor']['sha256'] = '0' * 64
        self.assertEqual(self.run_resolver([prepared])[0]['processingStatus'], 'eligible')
        self.set_code(self.code.replace('insertStaticSprite(0xabcdef01, 1100);',
                                         'insertStaticSprite(0xabcdef01, 1100);\n'
                                         'insertStaticSprite(0xabcdef01, 1100);'))
        entries = self.run_resolver([prepared])
        self.assertEqual(len(entries), 2)
        self.assertTrue(all(entry['processingStatus'] == 'eligible' for entry in entries))
        self.assertNotEqual(entries[0]['asset']['id'], entries[1]['asset']['id'])
        self.assertEqual(entries[0]['asset']['sourceIdentity']['runtimeKey'],
                         entries[1]['asset']['sourceIdentity']['runtimeKey'])

    def test_invalid_placement_and_frame_identity_block(self):
        self.db.execute('UPDATE decodedframes SET metadata_json=? WHERE id=?',
                        (json.dumps({'x': 639, 'y': 7}), 'sprite'))
        self.db.commit()
        self.assert_blocked('source-placement-outside-scene')
        self.db.execute('UPDATE decodedframes SET frame_index=1 WHERE id=?', ('sprite',))
        self.db.commit()
        self.assert_blocked('ambiguous-or-nonzero-decoded-frame')


if __name__ == '__main__':
    unittest.main()
