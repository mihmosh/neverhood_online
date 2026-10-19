import assert from 'node:assert/strict';
import test from 'node:test';
import { privateAssetPaths } from '../scripts/check-private-assets.mjs';

test('publication guard rejects raw archives, movies, save files and asset databases', () => {
  const paths = ['private-assets/catalog.sqlite', 'asset-workspace/frames/a.png', 'private-research/model/weights.safetensors', 'web/.private-research-no-public', 'docs/movie.SMK', 'web/assets/catalog.sqlite3', 'web/a.blb', 'web/setup.exe', 'data/neverhood.000', 'extracted/app/DATA/c.blb', 'original game/game.zip'];
  assert.deepEqual(privateAssetPaths(paths), paths);
  assert.deepEqual(privateAssetPaths(['web/prototype/render-abi.json', 'docs/images/onboarding.png', 'web/public/sources/project-build-sources.tar.xz', 'web/public/runtime/neverhood.dat', 'web/assets/fonts/Mansalva-Regular.ttf']), []);
});
