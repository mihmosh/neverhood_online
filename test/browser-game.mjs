export async function waitForGameFrame(page, mode = 'scene') {
  const deadline = Date.now() + (mode === 'menu' ? 15000 : 90000);
  while (Date.now() < deadline) {
    const png = await page.locator('#canvas').screenshot();
    const visible = await page.evaluate(async ({ data, mode }) => {
      const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(64, 48);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0, 64, 48);
      bitmap.close();
      const pixels = context.getImageData(0, 0, 64, 48).data;
      const colors = new Set();
      let textured = 0;
      let pink = 0;
      let warm = 0;
      for (let y = 4; y < 44; y++) {
        for (let x = 4; x < 60; x++) {
          const i = (y * 64 + x) * 4;
          const [r, g, b] = pixels.slice(i, i + 3);
          const orangeSplash = r > 140 && g > 45 && g < 160 && b < 35;
          if (Math.max(r, g, b) > 25 && !orangeSplash) textured++;
          if (r > 60 && r > g * 1.25 && b > g * 1.05 && r > b * 1.05) pink++;
          if (r > 100 && g > 70 && b > 50 && r > g && g > b) warm++;
          colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
        }
      }
      if (mode === 'room') return pink > 1000 && colors.size > 50;
      if (mode === 'menu') return warm > 1100 && colors.size > 50;
      return textured > 1100 && colors.size > 50;
    }, { data: png.toString('base64'), mode });
    if (visible) return;
    if (mode === 'room') await page.locator('#canvas').press('Space');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  throw new Error(`Expected game frame did not appear: ${mode}`);
}
