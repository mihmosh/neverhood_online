// SPDX-License-Identifier: GPL-3.0-or-later
// Version-pinned, read-only debug metadata; not a ScummVM production API.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseLayouts(text) {
  const records = {};
  for (const block of text.split('*** Dumping AST Record Layout')) {
    const lines = block.split('\n');
    const header = lines.findIndex(line => /^\s*0 \| (?:struct|class) /.test(line));
    if (header < 0) continue;
    const name = lines[header].replace(/^\s*0 \| (?:struct|class) /, '').replace(/\b(?:struct|class) /g, '').trim();
    const size = block.match(/\[sizeof=(\d+),.*?align=(\d+),/s);
    if (!size) continue;
    const fields = {};
    const bases = {};
    for (const line of lines.slice(header + 1)) {
      const match = line.match(/^\s*(\d+) \|   (\S.*)$/);
      if (!match) continue;
      const offset = Number(match[1]);
      const declaration = match[2];
      if (/\((?:primary )?base\)$/.test(declaration)) {
        bases[declaration.replace(/^(?:class|struct) /, '').replace(/ \((?:primary )?base\)$/, '')] = offset;
      } else {
        const field = declaration.match(/ ([_A-Za-z][_A-Za-z0-9]*)$/);
        if (field) fields[field[1]] = { offset, type: declaration.slice(0, -field[0].length) };
      }
    }
    const record = { size: Number(size[1]), alignment: Number(size[2]), fields, bases };
    if (records[name] && JSON.stringify(records[name]) !== JSON.stringify(record)) throw new Error(`Conflicting layout: ${name}`);
    records[name] = record;
  }
  return records;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

function main() {
  const source = resolve(root, 'scummvm');
  const build = resolve(root, 'scripts/.build/neverhood-web');
  const sdk = resolve(source, 'dists/emscripten/emsdk-4.0.10');
  const compiler = resolve(sdk, 'upstream/emscripten/em++');
  const runtime = JSON.parse(readFileSync(resolve(root, 'web/public/runtime/runtime.json')));
  const revision = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim();
  if (revision !== 'c546a4c80d2daf3bb1d5a3652279e26f762c0204' || revision !== runtime.sourceRevision || runtime.emsdk !== '4.0.10') throw new Error('Runtime/source/SDK mismatch');
  if (run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Upstream tracked source is modified');
  const scratch = resolve(build, 'render-abi');
  mkdirSync(scratch, { recursive: true });
  const layouts = {};
  const commands = [];
  const env = { ...process.env, EMSDK: sdk, EM_CACHE: resolve(sdk, 'upstream/emscripten/cache') };
  const compilerVersion = run(compiler, ['--version'], { env }).trim();
  if (!/4\.0\.10/.test(compilerVersion)) throw new Error('Unexpected compiler version');
  for (const unit of ['screen', 'gamemodule', 'modules/module1000', 'mouse', 'scene']) {
    const input = resolve(source, `engines/neverhood/${unit}.cpp`);
    const recipe = run('make', ['-n', '-o', 'configure', '-o', 'config.mk', '-o', 'config.h', '-o', 'configure.stamp', '-W', input, 'VERBOSE_BUILD=1', `engines/neverhood/${unit}.o`], { cwd: build, env });
    const line = recipe.split('\n').find(value => value.startsWith('em++ '));
    if (!line) throw new Error(`No compiler recipe for ${unit}`);
    // Remove only object/dependency outputs. Keep the configured compiler flags verbatim.
    const flags = line.slice('em++ '.length).replace(/-MMD -MF "[^"]+" -MQ "[^"]+" -MP /, '').replace(/ -c .*$/, '');
    const command = `"${compiler}" ${flags} -Xclang -fdump-record-layouts -fsyntax-only "${input}"`;
    commands.push({ cwd: build, command });
    const dump = run('bash', ['-c', command], { cwd: build, env });
    writeFileSync(resolve(scratch, `${unit.replaceAll('/', '-')}.layouts.txt`), dump);
    for (const [name, record] of Object.entries(parseLayouts(dump))) {
      if (layouts[name] && JSON.stringify(layouts[name]) !== JSON.stringify(record)) throw new Error(`Cross-TU mismatch: ${name}`);
      layouts[name] = record;
    }
  }
  const required = {
    'Neverhood::NeverhoodEngine': ['_screen', '_gameModule', '_gameVars', '_gameState', '_mouseX', '_mouseY'],
    'Neverhood::Scene': ['_mouseCursor'],
    'Neverhood::Mouse': ['_frameNum'],
    'Neverhood::StaticSprite': [],
    'Neverhood::Sprite': ['_surface', '_drawOffset'],
    'Common::SharedPtr<Neverhood::BaseSurface>': ['_pointer'],
    'Neverhood::BaseSurface': ['_surface', '_visible'],
    'Neverhood::NDrawRect': ['x', 'y'],
    'Neverhood::Screen': ['_backScreen', '_paletteData', '_prevRenderQueue', '_renderQueue', '_ticks', '_fullRefresh', '_smackerDecoder', '_yOffset'],
    'Common::Array<Neverhood::RenderItem>': ['_storage', '_size', '_capacity'],
    'Neverhood::RenderItem': ['_surface', '_shadowSurface', '_destX', '_destY', '_srcX', '_srcY', '_width', '_height', '_transparent', '_version', '_refresh', '_alphaColor'],
    'Graphics::Surface': ['w', 'h', 'pitch', 'pixels', 'format'],
    'Graphics::PixelFormat': ['bytesPerPixel'],
    'Neverhood::GameModule': ['_moduleNum', '_prevChildObject'],
    'Neverhood::Module': ['_childObject', '_sceneType'],
    'Neverhood::Module1000': ['_sceneNum'],
    'Neverhood::GameState': ['sceneNum', 'which'],
  };
  const selected = {};
  for (const [name, fields] of Object.entries(required)) {
    if (!layouts[name]) throw new Error(`Missing record ${name}`);
    for (const field of fields) if (!layouts[name].fields[field]) throw new Error(`Missing field ${name}::${field}`);
    selected[name] = layouts[name];
  }
  const wasm = readFileSync(resolve(root, 'web/public/runtime/scummvm.wasm'));
  const generatedJS = readFileSync(resolve(root, 'web/public/runtime/scummvm.js'), 'utf8');
  const heapExport = generatedJS.match(/(?:Module\[(?:"|')HEAPU8(?:"|')\]|Module\.HEAPU8)\s*=\s*[^;]{0,120}/);
  if (!heapExport && !(generatedJS.startsWith('var Module=') && /var HEAP8,HEAPU8[,;]/.test(generatedJS) && /HEAPU8=new Uint8Array\(b\)/.test(generatedJS))) throw new Error('No verified heap access in current generated JavaScript');
  const metadata = {
    schemaVersion: 1,
    purpose: 'Version-pinned read-only first-room debug adapter, not a production API',
    sourceRevision: revision,
    emsdk: runtime.emsdk,
    compilerVersion,
    buildConfigSHA256: createHash('sha256').update(readFileSync(resolve(build, 'config.mk'))).digest('hex'),
    target: 'wasm32-unknown-emscripten',
    pointerSize: 4,
    littleEndian: true,
    wasmBytes: wasm.length,
    wasmSHA256: createHash('sha256').update(wasm).digest('hex'),
    heapU8ExportPresent: Boolean(heapExport),
    heapU8ExportEvidence: heapExport?.[0] ?? null,
    generatedJsMemoryViewEvidence: generatedJS.match(/function updateMemoryViews\(\)\{[^}]+\}/)?.[0] ?? null,
    generatedJsHeapDeclarationEvidence: generatedJS.match(/var HEAP8[^;]+;/)?.[0] ?? null,
    heapAccess: { expression: heapExport ? 'Module.HEAPU8' : 'globalThis.HEAPU8', refresh: 'Re-read for every synchronous snapshot because memory growth replaces typed-array views', scope: 'Existing classic Emscripten script in the game iframe, not the parent page' },
    enginePointer: { export: 'Module._g_engine', indirections: 1, baseType: 'Engine', derivedType: 'Neverhood::NeverhoodEngine', baseOffset: selected['Neverhood::NeverhoodEngine'].bases.Engine },
    firstRoom: {
      room: 1001,
      module: 1000,
      scene: 0,
      normalSceneType: 0,
      checks: [
        'Engine and Screen pointers are nonzero and all reads are heap-bounds checked',
        'GameModule._moduleNum == 1000',
        'GameModule._prevChildObject == 0 (menu swaps child without changing module number)',
        'GameModule._restoreGameRequested == false and _restartGameRequested == false and _mainMenuRequested == false',
        'GameModule inherited Module._childObject is nonzero; interpret that child as Module1000 only after preceding checks',
        'Module1000._sceneNum == 0 and inherited Module._sceneType == 0',
        'Module1000 inherited Module._childObject is nonzero and _done == false',
        'Screen._smackerDecoder == 0 and _fullRefresh == false and _yOffset == 0',
        'Screen._renderQueue size == 0; completed _prevRenderQueue has a nonzero bounded size <= capacity',
        'Reconstructed native indexed pixels exactly match Screen._backScreen before presenting an external frame',
      ],
      evidence: [
        { path: 'engines/neverhood/modules/module1000.cpp', lines: [50, 57], meaning: 'Module1000 scene zero constructs Scene1001' },
        { path: 'engines/neverhood/gamemodule.cpp', lines: [455, 457], meaning: 'createModule records active module number' },
        { path: 'engines/neverhood/gamemodule.cpp', lines: [827, 844], meaning: 'Menus save original child in _prevChildObject; module number alone cannot exclude menus' },
        { path: 'engines/neverhood/module.h', lines: [39, 42], meaning: 'Normal scene enum is zero; Smacker is one' },
      ],
    },
    frameQueue: {
      completed: '_prevRenderQueue',
      pending: '_renderQueue',
      pointerLifetime: 'Borrowed surfaces and palette belong to engine; never retain pointers or heap views across asynchronous work or memory growth. Snapshot synchronously at a stable completed frame boundary.',
      validity: 'Only normal queued drawing swaps queues. Full-refresh/video paths return before swap. After transitions a nonzero previous queue is not proof that its borrowed surface pointers are live. Require all gate checks and exact native indexed-pixel comparison; otherwise fall back.',
      palette: { entries: 256, stride: 4, rgbOffsets: [0, 1, 2] },
      evidence: [
        { path: 'engines/neverhood/screen.cpp', lines: [52, 60], meaning: 'Full-refresh bypasses queue processing and swap' },
        { path: 'engines/neverhood/screen.cpp', lines: [92, 104], meaning: 'Completed drawing queue becomes previous queue; pending queue is cleared' },
        { path: 'engines/neverhood/screen.cpp', lines: [163, 171], meaning: 'Palette is 256 four-byte entries; RGB are first three bytes' },
        { path: 'engines/neverhood/neverhood.cpp', lines: [228, 241], meaning: 'Engine updates/draws/screens before yielding in delayMillis' },
        { path: 'engines/neverhood/neverhood.h', lines: [69, 99], meaning: 'NeverhoodEngine derives from Engine; layout confirms base at offset zero' },
      ],
    },
    cursor: {
      source: 'Module1000 child Scene._mouseCursor -> Sprite._surface SharedPtr._pointer -> BaseSurface._surface',
      position: 'NeverhoodEngine._mouseX/_mouseY in logical coordinates',
      hotspot: 'negative Sprite._drawOffset.x/y; index zero is transparent; backend clips at screen bounds',
      parity: 'Separate backend cursor pass, excluded from native backbuffer and scene comparison',
      palette: 'Engine constructor pushes empty cursor palette (disabled); Neverhood never enables a separate cursor palette. Use Screen._paletteData RGB.',
      evidence: [
        { path: 'engines/neverhood/mouse.cpp', lines: [91, 101, 182, 187], meaning: 'Visibility follows BaseSurface; original animated 32x32 surface and negative draw-offset hotspot are passed to CursorMan' },
        { path: 'engines/engine.cpp', lines: [188, 191], meaning: 'Engine dummy cursor palette disables distinct cursor palette' },
        { path: 'backends/graphics/opengl/opengl-graphics.cpp', lines: [1915, 1918], meaning: 'Current OpenGL backend uses game palette when distinct cursor palette is disabled' },
      ],
    },
    records: selected,
    commands,
  };
  if (metadata.enginePointer.baseOffset !== 0) throw new Error('Engine base is not at offset zero');
  const output = resolve(root, 'web/prototype/render-abi.json');
  writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(JSON.stringify({ output, wasmBytes: wasm.length, wasmSHA256: metadata.wasmSHA256, records: Object.keys(selected) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
