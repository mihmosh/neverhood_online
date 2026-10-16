export function bufferWorkerReads(workerFS, readSlice = blob => new FileReaderSync().readAsArrayBuffer(blob), pageSize = 4 * 1024 ** 2, maxPages = 4) {
  const pages = new Map();
  workerFS.stream_ops.read = (stream, buffer, offset, length, position) => {
    const node = stream.node;
    const amount = Math.max(0, Math.min(length, node.size - position));
    let copied = 0;
    while (copied < amount) {
      const cursor = position + copied;
      const start = Math.floor(cursor / pageSize) * pageSize;
      const key = `${node.id}:${start}`;
      let page = pages.get(key);
      if (!page) {
        page = new Uint8Array(readSlice(node.contents.slice(start, Math.min(start + pageSize, node.size))));
        if (!page.length) throw new Error('The installer file could not be read.');
        if (pages.size >= maxPages) pages.delete(pages.keys().next().value);
      } else pages.delete(key);
      pages.set(key, page);
      const available = Math.min(amount - copied, page.length - (cursor - start));
      if (available <= 0) throw new Error('The installer file was truncated while being read.');
      buffer.set(page.subarray(cursor - start, cursor - start + available), offset + copied);
      copied += available;
    }
    return copied;
  };
}
