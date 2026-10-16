/* global createInnoextract */
let resume;

self.onmessage = async ({ data }) => {
  if (data.type === 'continue') { resume?.(); return; }
  if (data.type !== 'extract') return;
  const errors = [];
  try {
    const { parseInstallerListing, MAX_OUTPUT_BYTES } = await import('./installer-validation.js');
    const { bufferWorkerReads } = await import('./worker-file-cache.js');
    importScripts(data.moduleURL);
    const create = async (lines, report = false) => {
      const module = await createInnoextract({
        noInitialRun: true,
        locateFile: name => new URL(name, data.moduleURL).href,
        print: line => {
          if (lines.length < 10000) lines.push(line);
          else throw new Error('The installer contains too many listing entries.');
          if (report && /^\s*-/.test(line)) self.postMessage({ type: 'progress', phase: 'extract', detail: line.trim() });
        },
        printErr: line => { errors.push(String(line)); if (errors.length > 20) errors.shift(); },
      });
      // C++ makes many small reads. Cache bounded pages instead of invoking
      // FileReaderSync for every byte-sized or kilobyte-sized request.
      bufferWorkerReads(module.WORKERFS);
      module.FS.mkdir('/input');
      module.FS.mount(module.WORKERFS, { files: data.files }, '/input');
      module.FS.mkdir('/output');
      return module;
    };
    const run = (module, args) => {
      let status;
      try { status = module.callMain(args); }
      catch (error) {
        if (typeof error.status !== 'number') throw error;
        status = error.status;
      }
      if (status !== 0) throw new Error(`Installer extraction failed (exit ${status}). ${errors.join(' ').slice(-3000)}`);
    };
    const common = ['--silent', '--color=0', '--progress=0', '--no-extract-unknown'];
    const listing = [];
    self.postMessage({ type: 'progress', phase: 'inspect', detail: 'Reading the Inno Setup file table...' });
    let metadata = await create(listing);
    run(metadata, ['--list', '--list-sizes', ...common, `/input/${data.executable}`]);
    const plan = parseInstallerListing(listing);
    metadata = null;
    const permitted = new Promise(resolve => { resume = resolve; });
    self.postMessage({ type: 'plan', upperBytes: plan.upperBytes });
    await permitted;

    const extraction = await create([], true);
    const fs = extraction.FS;
    const allowed = new Map(plan.entries.map(entry => [`/output/${entry.path}`, entry]));
    const sizes = new Map();
    const write = fs.write.bind(fs);
    fs.write = (stream, buffer, offset, length, position, ...rest) => {
      if (stream.path?.startsWith('/output/')) {
        const entry = allowed.get(stream.path);
        if (!entry) throw new Error('The extractor attempted to write an unselected resource.');
        const end = (typeof position === 'number' ? position : stream.position) + length;
        sizes.set(stream.path, Math.max(sizes.get(stream.path) || 0, end));
        if (end > entry.upperBytes || [...sizes.values()].reduce((sum, size) => sum + size, 0) > MAX_OUTPUT_BYTES) {
          throw new Error('Extracted resources exceed the declared size limit.');
        }
      }
      return write(stream, buffer, offset, length, position, ...rest);
    };
    self.postMessage({ type: 'progress', phase: 'extract', detail: 'Decompressing and verifying the selected game archives...' });
    const includes = plan.entries.flatMap(entry => ['--include', `/${entry.path}`]);
    run(extraction, ['--extract', ...common, '--output-dir', '/output', ...includes, `/input/${data.executable}`]);
    const outputs = plan.entries.map(entry => {
      const info = fs.stat(`/output/${entry.path}`);
      if (!fs.isFile(info.mode) || info.size !== entry.upperBytes) throw new Error(`${entry.name}: extracted size is invalid.`);
      return { ...entry, size: info.size };
    });
    const total = outputs.reduce((sum, entry) => sum + entry.size, 0);
    const chunk = new Uint8Array(1024 * 1024);
    let copied = 0;
    for (const entry of outputs) {
      const handle = await data.stage.getFileHandle(entry.name, { create: true });
      const destination = await handle.createWritable();
      const source = fs.open(`/output/${entry.path}`, 'r');
      try {
        for (let offset = 0; offset < entry.size;) {
          const count = fs.read(source, chunk, 0, Math.min(chunk.length, entry.size - offset), offset);
          if (!count) throw new Error(`${entry.name}: unexpected end of extracted resource.`);
          await destination.write(chunk.subarray(0, count));
          offset += count;
          copied += count;
          self.postMessage({ type: 'progress', phase: 'stage', name: entry.name, copied, total });
        }
        await destination.close();
      } catch (error) {
        await destination.abort().catch(() => {});
        throw error;
      } finally { fs.close(source); }
      fs.unlink(`/output/${entry.path}`);
    }
    self.postMessage({ type: 'done', files: outputs.map(({ name, size }) => ({ name, size })), total });
  } catch (error) {
    self.postMessage({ type: 'error', name: error.name, message: `${error.message || error}${errors.length ? ` ${errors.join(' ').slice(-3000)}` : ''}`.slice(0, 4096) });
  } finally { self.close(); }
};
