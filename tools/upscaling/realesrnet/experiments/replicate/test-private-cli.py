#!/usr/bin/env python3
"""Offline CLI safety checks; synthetic files only, API fetch disabled."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrivateCLI(unittest.TestCase):
    def test_python_private_paths(self):
        for name in ('prepare-seedvr2-probe', 'analyze-seedvr2-probe'):
            module = load(name)
            for path in (REPO, REPO / 'private-assets/probe', REPO / 'web/public/probe',
                         Path('/tmp/kilo/public/probe')):
                with self.subTest(script=name, path=path), self.assertRaises(ValueError):
                    module.private_directory(path)
            self.assertEqual(module.private_directory(Path('/tmp/kilo/private-probe')),
                             Path('/tmp/kilo/private-probe'))

    def python_cli(self, name, *args):
        return subprocess.run(['python3', str(HERE / name), *map(str, args)],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                                   'NEVERHOOD_SEEDVR2_PROBE_DIR': ''})

    def test_required_python_arguments(self):
        result = self.python_cli('prepare-seedvr2-probe.py', '--inspect')
        self.assertEqual(result.returncode, 2)
        self.assertIn('--manifest', result.stderr)
        self.assertIn('--output', result.stderr)
        result = self.python_cli('analyze-seedvr2-probe.py')
        self.assertEqual(result.returncode, 2)
        self.assertIn('supply --base', result.stderr)

    def test_manifest_only_inspection_and_source_rejection(self):
        with tempfile.TemporaryDirectory(prefix='seedvr2-cli-', dir='/tmp/kilo') as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            manifest = source / 'manifest.json'
            manifest.write_text(json.dumps({'cases': [{'resource': 'synthetic', 'label': 'Synthetic',
                'frames': [{'metadata': {'x': 0, 'y': 0, 'width': 2, 'height': 3, 'durationTicks': 1}}]}]}))
            result = self.python_cli('prepare-seedvr2-probe.py', '--manifest', manifest,
                                     '--output', root / 'input', '--inspect')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['bounds'], [0, 0, 2, 3])
            self.assertFalse((root / 'input').exists())
            result = self.python_cli('prepare-seedvr2-probe.py', '--manifest', manifest,
                                     '--output', source / 'input', '--inspect')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source manifest directory', result.stderr)

    def node_cli(self, name, args, environment=None, success=False):
        # Abort before any network operation even if validation regresses.
        code = "globalThis.fetch = () => { throw new Error('NETWORK_DISABLED_FOR_TEST'); }; "
        code += f"process.argv = ['node', {json.dumps(str(HERE / name))}, ...{json.dumps(args)}]; "
        code += f"await import({json.dumps((HERE / name).as_uri())});"
        env = {**os.environ, 'NEVERHOOD_SEEDVR2_PROBE_DIR': '', 'REPLICATE_API_TOKEN': ''}
        env.update(environment or {})
        result = subprocess.run(['node', '--input-type=module', '-e', code], env=env,
                                capture_output=True, text=True, check=False)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('NETWORK_DISABLED_FOR_TEST', result.stderr)
        return result

    def test_api_requires_mode_and_explicit_paid_consent(self):
        name = 'seedvr2-replicate-probe.mjs'
        self.assertIn('Usage:', self.node_cli(name, []).stderr)
        for mode in ('run', 'papina'):
            self.assertIn('--allow-paid', self.node_cli(name, [mode]).stderr)
        self.assertIn('Supply --base', self.node_cli(name, ['inspect']).stderr)
        self.assertIn('outside source/public', self.node_cli(name, ['inspect', '--base', str(REPO)]).stderr)
        self.assertIn('Unknown option', self.node_cli(name, ['inspect', '--token', 'not-a-token']).stderr)
        with tempfile.TemporaryDirectory(prefix='seedvr2-cli-', dir='/tmp/kilo') as temp:
            result = self.node_cli(name, ['inspect', '--base', temp])
            self.assertIn('REPLICATE_API_TOKEN is missing', result.stderr)
            self.assertFalse((Path(temp) / 'runs').exists())
            (Path(temp) / 'runs').symlink_to(REPO, target_is_directory=True)
            result = self.node_cli(name, ['inspect', '--base', temp])
            self.assertIn('Symlinked experiment path', result.stderr)

    def test_serve_requires_private_base(self):
        name = 'serve-seedvr2-probe.mjs'
        self.assertIn('Usage:', self.node_cli(name, []).stderr)
        self.assertIn('outside source/public',
                      self.node_cli(name, ['--base', str(REPO)]).stderr)

    def test_node_help_needs_no_data_or_token(self):
        for name in ('seedvr2-replicate-probe.mjs', 'serve-seedvr2-probe.mjs'):
            result = self.node_cli(name, ['--help'], success=True)
            self.assertIn('Usage:', result.stdout)


if __name__ == '__main__':
    unittest.main()
