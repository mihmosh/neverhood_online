import { formatBytes, editionWarning } from './lib/validation.js';
import { storageSupported, getLibrary, deleteLibrary, withStorageLock, describeStorageError } from './lib/storage.js';
import { discoverRuntime } from './lib/runtime.js';
import { discoverExtractor } from './lib/installer.js';
import { importGameSource } from './lib/source.js';
import { createSaveControls } from './lib/save-controls.js';

const $ = id => document.getElementById(id);
let library = null;
let libraryError = false;
let libraryChecked = false;
let source = null;
let busy = false;
let saveBusy = false;
let saveControls;
let running = false;
let runtime = { available: false };
let extractor = { available: false };
let importController;
let gameController;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = !text;
}

function controls() {
  const supported = storageSupported();
  const state = !libraryChecked ? 'checking' : busy ? (importController ? 'preparing' : 'removing') : library ? 'ready' : libraryError ? 'error' : 'empty';
  $('library-panel').dataset.state = state;
  $('library-panel').setAttribute('aria-busy', String(busy || saveBusy || !libraryChecked));
  $('library-title').textContent = { checking: 'Checking this browser...', preparing: 'Getting your game ready', removing: 'Removing local game data', ready: 'Ready to play', error: "Let's fix your local copy", empty: 'Add your game' }[state];
  $('import-state').hidden = !libraryChecked || Boolean(library) || (busy && !importController);
  $('ready-state').hidden = !library || busy;
  $('remove-control').hidden = !libraryChecked || (!library && !libraryError);
  for (const id of ['game-folder', 'game-archive']) $(id).disabled = busy || saveBusy || running || !supported;
  $('prepare').disabled = busy || saveBusy || running || !source || !supported;
  $('delete').disabled = busy || saveBusy || running || !supported || (!library && !libraryError);
  $('persist').disabled = busy || saveBusy || running || !supported || !navigator.storage?.persist;
  $('play').disabled = busy || saveBusy || running || !library || !runtime.available;
  $('cancel-import').hidden = !importController;
  $('cancel-import').disabled = !importController || importController.signal.aborted;
  saveControls?.update();
}

saveControls = createSaveControls({
  onBusy(value) { saveBusy = value; controls(); },
  isBlocked: () => busy || running || !libraryChecked,
});

async function storageInfo() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    $('storage-size').textContent = estimate ? `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}` : 'Not available';
    if (await navigator.storage?.persisted?.()) $('persistence').textContent = 'The browser is keeping your files. Clearing site data still removes the game and saves.';
  } catch { $('storage-size').textContent = 'Not available'; }
}

async function refreshLibrary() {
  library = null;
  libraryError = false;
  $('library-details').hidden = true;
  $('library-warning').textContent = '';
  try {
    library = await getLibrary();
    $('library-status').textContent = library ? 'Your game is ready on this device.' : 'Import once, then play from this browser.';
    if (library) {
      const details = $('library-details');
      details.replaceChildren();
      for (const [label, value] of [['Game size', formatBytes(library.total)], ['Added', new Date(library.importedAt).toLocaleDateString('en-US')]]) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        details.append(dt, dd);
      }
      details.hidden = false;
      $('library-warning').textContent = editionWarning(library.files.find(file => file.name === 'hd.blb').size);
    }
  } catch (error) {
    libraryError = true;
    $('library-status').textContent = describeStorageError(error);
  }
  libraryChecked = true;
  await storageInfo();
  controls();
}

for (const id of ['game-folder', 'game-archive']) {
  $(id).addEventListener('change', () => {
    const files = [...$(id).files];
    source = null;
    if (files.length) {
      $(id === 'game-folder' ? 'game-archive' : 'game-folder').value = '';
      if (id === 'game-archive' && !/\.zip$/i.test(files[0].name)) {
        message('Please choose a ZIP archive. Unpack RAR or 7z archives into a folder first.', true);
      } else {
        source = id === 'game-folder' ? { files } : { archive: files[0] };
        $('selection').textContent = id === 'game-folder' ? `Folder chosen (${files.length} files). Ready to prepare.` : `${files[0].name} is ready to prepare.`;
        message('');
      }
    }
    if (!source) $('selection').textContent = 'No files selected yet.';
    controls();
  });
}

$('prepare').addEventListener('click', async () => {
  if (!source || busy || saveBusy || running) return;
  busy = true;
  importController = new AbortController();
  controls();
  $('progress-wrap').hidden = false;
  $('progress').removeAttribute('value');
  $('progress-label').textContent = 'Finding your game...';
  message('Getting your game ready. Please keep this tab open.');
  try {
    await importGameSource(source, progress => {
      if (!importController || importController.signal.aborted) return;
      const total = progress.total;
      const copied = progress.copied;
      if (Number.isFinite(total) && total > 0 && Number.isFinite(copied)) $('progress').value = copied / total * 100;
      else $('progress').removeAttribute('value');
      $('progress-label').textContent = progress.detail || (copied != null && total ? `Saving your game: ${Math.round(copied / total * 100)}%` : 'Preparing your game...');
    }, { signal: importController.signal, extractor: extractor.descriptor });
    message('All ready! Press Play to visit Neverhood.');
    source = null;
    $('game-folder').value = '';
    $('game-archive').value = '';
    $('selection').textContent = 'Your game has been added.';
  } catch (error) {
    message(error.name === 'AbortError' ? 'Stopped. Your previous game has not been replaced.' : describeStorageError(error), error.name !== 'AbortError');
  } finally {
    importController = null;
    busy = false;
    $('progress-wrap').hidden = true;
    await refreshLibrary();
    if (library && runtime.available) $('play').focus();
  }
});

$('cancel-import').addEventListener('click', () => {
  importController?.abort();
  $('progress-label').textContent = 'Stopping and tidying up...';
  controls();
});

$('persist').addEventListener('click', async () => {
  if (busy || saveBusy || running) return;
  try {
    const granted = await navigator.storage.persist();
    message(granted ? 'The browser will keep your files unless you clear site data.' : 'Your game still works. The browser may remove its files if space runs low.');
    await storageInfo();
  } catch (error) { message(describeStorageError(error), true); }
});

$('delete').addEventListener('click', () => {
  if (busy || saveBusy || running || (!library && !libraryError)) return;
  $('delete-dialog').returnValue = '';
  $('delete-dialog').showModal();
});
$('delete-dialog').addEventListener('close', async () => {
  if ($('delete-dialog').returnValue !== 'delete' || busy || saveBusy || running) return;
  busy = true;
  controls();
  try {
    await deleteLibrary();
    source = null;
    $('game-folder').value = '';
    $('game-archive').value = '';
    $('selection').textContent = 'No files selected yet.';
    message('Game removed from this browser. Your original files and saved games are unchanged.');
  }
  catch (error) { message(describeStorageError(error), true); }
  finally { busy = false; await refreshLibrary(); if (!library) $('game-folder').focus(); }
});

$('play').addEventListener('click', async () => {
  if (!library || !runtime.available || busy || saveBusy || running) return;
  running = true;
  gameController = new AbortController();
  controls();
  $('game').hidden = false;
  $('game-loading').hidden = false;
  $('game-status').textContent = 'Starting the player...';
  $('game-progress').removeAttribute('value');
  $('site').inert = true;
  document.querySelector('header').inert = true;
  document.querySelector('footer').inert = true;
  document.body.classList.add('playing');
  $('stop-game').disabled = false;
  $('stop-game').focus();
  try {
    await withStorageLock(async () => {
      gameController.signal.throwIfAborted();
      await getLibrary();
      await runtime.start({ container: $('player-host'), signal: gameController.signal, onStatus: (text, progress, state) => {
        $('game-status').textContent = text;
        if (Number.isFinite(progress)) $('game-progress').value = progress;
        else $('game-progress').removeAttribute('value');
        if (state === 'playing') $('game-loading').hidden = true;
        if (state === 'stopping') $('game-loading').hidden = false;
      } });
    }, { signal: gameController.signal });
    message('Back home. You can play again whenever you like.');
  } catch (error) {
    if (error.name !== 'AbortError') message(`Game player: ${error.message}`, true);
  } finally {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    $('game').hidden = true;
    $('player-host').replaceChildren();
    $('site').inert = false;
    document.querySelector('header').inert = false;
    document.querySelector('footer').inert = false;
    document.body.classList.remove('playing');
    gameController = null;
    running = false;
    controls();
    $('play').focus();
    await saveControls.refresh();
  }
});

$('stop-game').addEventListener('click', () => {
  $('stop-game').disabled = true;
  $('game-loading').hidden = false;
  $('game-status').textContent = 'Saving and returning to the site...';
  gameController?.abort();
});
$('fullscreen').hidden = !document.documentElement.requestFullscreen;
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('game').requestFullscreen();
  } catch { $('game-status').textContent = 'Full screen is not available. You can keep playing here.'; }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen'; });
window.addEventListener('beforeunload', event => {
  if (busy || saveBusy || running) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('focus', async () => {
  if (busy || saveBusy || running) return;
  await refreshLibrary();
  await saveControls.refresh();
});

controls();
await refreshLibrary();
await saveControls.refresh();
[runtime, extractor] = await Promise.all([discoverRuntime(), discoverExtractor()]);
$('runtime-status').textContent = runtime.available ? 'The player is ready.' : 'The game player is unavailable right now.';
$('extractor-status').textContent = extractor.available ? 'Game folders and supported installers can be read on this device.' : 'Installer extraction is unavailable. A folder with already unpacked game files will still work.';
controls();
