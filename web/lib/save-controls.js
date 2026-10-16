import { listSaves, prepareSaveImport, importSaves, exportSaves, exportSaveBackup } from './save-store.js';
import { formatBytes } from './validation.js';

const $ = id => document.getElementById(id);

function renderFiles(id, files, sizes = false) {
  const list = $(id);
  list.replaceChildren();
  for (const file of files) {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    const detail = document.createElement('span');
    name.textContent = file.name;
    detail.textContent = `${file.description || 'Untitled save'}${sizes ? ` (${formatBytes(file.bytes)})` : ''}`;
    item.append(name, detail);
    list.append(item);
  }
}

function download({ name, bytes }) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('No save data was available to download.');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Safari may consume the URL after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function createSaveControls({ onBusy, isBlocked }) {
  let busy = false;
  let plan = null;
  let importing = false;
  let saveCount = 0;

  function status(text, error = false, dialog = false) {
    const target = $(dialog ? 'save-dialog-status' : 'save-status');
    target.textContent = text;
    target.classList.toggle('error', error);
  }

  function update() {
    const disabled = busy || isBlocked() || !globalThis.isSecureContext || !globalThis.indexedDB;
    for (const id of ['save-files', 'save-backups']) $(id).disabled = disabled || (id === 'save-backups' && !$(id).value);
    $('import-saves').disabled = disabled || !$('save-files').files.length;
    $('export-saves').disabled = disabled || !saveCount;
    $('export-save-backup').disabled = disabled || !$('save-backups').value;
    $('allow-save-overwrite').disabled = importing || !plan;
    $('cancel-save-import').disabled = importing;
    $('confirm-save-import').disabled = !plan || importing || (plan.conflicts.length > 0 && !$('allow-save-overwrite').checked);
  }

  function setBusy(value) {
    busy = value;
    onBusy(value);
    update();
  }

  async function loadList() {
    const result = await listSaves();
    saveCount = result.files.length;
    renderFiles('save-list', result.files, true);
    const selected = $('save-backups').value;
    $('save-backups').replaceChildren();
    for (const backup of result.backups) {
      const option = document.createElement('option');
      option.value = backup.id;
      option.textContent = new Date(backup.createdAt).toLocaleString('en-US');
      $('save-backups').append(option);
    }
    if (!result.backups.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No backups yet';
      $('save-backups').append(option);
    } else if (result.backups.some(backup => backup.id === selected)) $('save-backups').value = selected;
    return result;
  }

  async function refresh() {
    if (busy || isBlocked()) return;
    setBusy(true);
    try {
      const result = await loadList();
      status(result.files.length ? `${result.files.length} saved game${result.files.length === 1 ? '' : 's'} in this browser.` : 'No saved games in this browser yet.');
    } catch (error) { status(error.message || 'Saved games could not be read. Please try again.', true); }
    finally { setBusy(false); }
  }

  function cancelReview() {
    if (importing) return;
    if (plan) status('Import canceled. No saved games were changed.');
    plan = null;
    $('allow-save-overwrite').checked = false;
    setBusy(false);
  }

  $('save-files').addEventListener('change', () => {
    const files = [...$('save-files').files];
    $('save-selection').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected. Review before importing.` : 'No save files selected.';
    update();
  });
  $('save-backups').addEventListener('change', update);
  $('allow-save-overwrite').addEventListener('change', update);
  $('cancel-save-import').addEventListener('click', () => $('save-import-dialog').close());
  $('save-import-dialog').addEventListener('cancel', event => { if (importing) event.preventDefault(); });
  $('save-import-dialog').addEventListener('close', cancelReview);

  $('import-saves').addEventListener('click', async () => {
    if (busy || isBlocked() || !$('save-files').files.length) return;
    setBusy(true);
    status('Checking selected saves...');
    try {
      plan = await prepareSaveImport([...$('save-files').files]);
      renderFiles('save-import-files', plan.files);
      renderFiles('save-import-conflicts', plan.conflicts);
      $('save-overwrite-review').hidden = !plan.conflicts.length;
      $('allow-save-overwrite').checked = false;
      $('confirm-save-import').textContent = plan.conflicts.length ? 'Back up & replace' : 'Import saves';
      status('', false, true);
      update();
      $('save-import-dialog').showModal();
      status('Review the selected saves before importing.');
    } catch (error) {
      plan = null;
      status(error.message || 'These saves could not be imported.', true);
      setBusy(false);
    }
  });

  $('confirm-save-import').addEventListener('click', async () => {
    if (!plan || importing || (plan.conflicts.length && !$('allow-save-overwrite').checked)) return;
    importing = true;
    update();
    status('Saving your import. Please keep this tab open.', false, true);
    try {
      const result = await importSaves(plan, { overwrite: plan.conflicts.length > 0 && $('allow-save-overwrite').checked });
      plan = null;
      $('save-files').value = '';
      $('save-selection').textContent = 'No save files selected.';
      // Keep the operation locked through the post-import refresh.
      const imported = `Imported ${result.count} saved game${result.count === 1 ? '' : 's'}.${result.backupId ? ' A before-import backup is available below.' : ''}`;
      try {
        await loadList();
        status(imported);
      } catch (error) { status(`${imported} The save list could not be refreshed: ${error.message}`, true); }
      $('save-import-dialog').close();
    } catch (error) {
      // A stale plan must be reviewed again, never silently retried with overwrite.
      plan = null;
      const text = `${error.message || 'The import could not be completed.'} Close this review and select your saves again.`;
      status(text, true);
      status(text, true, true);
    } finally {
      importing = false;
      if (!$('save-import-dialog').open) setBusy(false);
      update();
    }
  });

  for (const [id, action] of [['export-saves', () => exportSaves()], ['export-save-backup', () => exportSaveBackup($('save-backups').value)]]) {
    $(id).addEventListener('click', async () => {
      if (busy || isBlocked() || $(id).disabled) return;
      setBusy(true);
      status('Preparing your save download...');
      try {
        const archive = await action();
        download(archive);
        status('Save ZIP prepared. Keep the downloaded file somewhere safe.');
      } catch (error) { status(error.message || 'The save ZIP could not be downloaded.', true); }
      finally { setBusy(false); }
    });
  }

  return { update, refresh };
}
