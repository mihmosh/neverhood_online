import { readFile, realpath, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2), allowAdded = args.at(-1) === '--allow-added-metrics';
if (allowAdded) args.pop();
if (args.length !== 3) throw new Error('Usage: promote-comparison.mjs CURRENT NEW BACKUP [--allow-added-metrics]');
const [current, next, backup] = args.map(path => resolve(path));
if (current === next || current === backup || next === backup || await realpath(current) !== current || await realpath(next) !== next) throw new Error('Unsafe comparison paths');
try { await stat(backup); throw new Error('Backup already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const before = JSON.parse(await readFile(resolve(current, 'report.json'), 'utf8'));
const after = JSON.parse(await readFile(resolve(next, 'report.json'), 'utf8'));
function preserved(value, updated) {
  if (Array.isArray(value)) return Array.isArray(updated) && value.length === updated.length && value.every((entry, index) => preserved(entry, updated[index]));
  if (value && typeof value === 'object') return updated && typeof updated === 'object' && Object.entries(value).every(([key, entry]) => Object.hasOwn(updated, key) && preserved(entry, updated[key]));
  return value === updated;
}
const sameMetrics = allowAdded ? preserved(before.metrics, after.metrics) : JSON.stringify(before.metrics) === JSON.stringify(after.metrics);
if (before.status !== 'complete' || after.status !== 'complete' || !sameMetrics) throw new Error('Presentation update changed existing model metrics');
await rename(current, backup);
try { await rename(next, current); } catch (error) { await rename(backup, current); throw error; }
console.log(JSON.stringify({ current, backup, existingMetricsUnchanged: true, allowAddedMetrics: allowAdded }));
