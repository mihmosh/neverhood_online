// Transfer stages share a byte-weighted budget; verification and first paint
// retain their own budget so a completed download never implies playability.
export function createDemoProgress({ nativeBytes, roomBytes }, report) {
  const total = Math.max(1, nativeBytes + roomBytes);
  const roomWeight = 88 * roomBytes / total;
  const stages = {
    engine: [0, 6], room: [6, roomWeight],
    verify: [6 + roomWeight, 4],
    native: [10 + roomWeight, 88 - roomWeight], ready: [98, 2],
  };
  let progress = 0;
  return (stage, fraction, text) => {
    if (!stages[stage] || !Number.isFinite(fraction)) return progress;
    const [offset, weight] = stages[stage];
    progress = Math.max(progress, Math.min(100, offset + weight * Math.max(0, Math.min(1, fraction))));
    report(text, progress, 'loading');
    return progress;
  };
}
