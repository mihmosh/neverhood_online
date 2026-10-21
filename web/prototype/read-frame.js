export class RenderFrameReader {
  constructor(module, abi, { allRooms = false } = {}) {
    if (abi?.schemaVersion !== 1 || abi.pointerSize !== 4 || !abi.littleEndian || !abi.records) throw new Error('Unsupported render-adapter layout.');
    this.module = module;
    this.allRooms = allRooms;
    this.abi = abi;
    const record = name => {
      const value = abi.records[name];
      if (!value) throw new Error(`Missing compiled layout: ${name}`);
      return { size: value.size, ...Object.fromEntries(Object.entries(value.fields).map(([name, field]) => [name, field.offset])) };
    };
    this.layout = { engine: record('Neverhood::NeverhoodEngine'), screen: record('Neverhood::Screen'), array: record('Common::Array<Neverhood::RenderItem>'), item: record('Neverhood::RenderItem'), surface: record('Graphics::Surface'), pixelFormat: record('Graphics::PixelFormat'), game: record('Neverhood::GameModule'), module: record('Neverhood::Module'), roomModule: record('Neverhood::Module1000') };
    this.layout.surface.bytesPerPixel = this.layout.surface.format + this.layout.pixelFormat.bytesPerPixel;
    Object.assign(this.layout, { scene: record('Neverhood::Scene'), mouse: record('Neverhood::Mouse'), sprite: record('Neverhood::Sprite'), shared: record('Common::SharedPtr<Neverhood::BaseSurface>'), baseSurface: record('Neverhood::BaseSurface'), rect: record('Neverhood::NDrawRect') });
    if (abi.records['Neverhood::Mouse'].bases['Neverhood::StaticSprite'] !== 0 || abi.records['Neverhood::StaticSprite']?.bases['Neverhood::Sprite'] !== 0) throw new Error('Unsupported cursor inheritance layout.');
  }

  read({ reference: includeReference = true } = {}) {
    this.inRoom = false;
    this.room = undefined;
    const heap = globalThis.HEAPU8;
    if (!(heap instanceof Uint8Array)) throw new Error('The runtime does not expose its read-only heap view.');
    const data = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
    const layout = this.layout;
    const range = (address, bytes) => {
      if (!Number.isSafeInteger(address) || !Number.isSafeInteger(bytes) || address < 4 || bytes < 0 || address + bytes > heap.length) throw new Error('Render adapter rejected an invalid heap range.');
      return address;
    };
    const ptr = address => { range(address, 4); return data.getUint32(address, true); };
    const uint = address => { range(address, 4); return data.getUint32(address, true); };
    const short = address => { range(address, 2); return data.getInt16(address, true); };
    const byte = address => { range(address, 1); return data.getUint8(address); };
    const engine = ptr(this.module._g_engine);
    if (!engine) return { available: false, reason: 'Waiting for the game engine.' };
    range(engine, layout.engine.size);
    const screen = ptr(engine + layout.engine._screen);
    if (!screen) return { available: false, reason: 'Waiting for the game screen.' };
    range(screen, layout.screen.size);
    const game = ptr(engine + layout.engine._gameModule);
    if (!game) return { available: false, reason: 'Waiting for the game module.' };
    range(game, layout.game.size);
    const moduleNum = uint(game + layout.game._moduleNum);
    const supported = this.allRooms ? moduleNum >= 1000 && moduleNum <= 3000 && moduleNum % 100 === 0 : moduleNum === 1000;
    if (!supported || ptr(game + layout.game._prevChildObject) || byte(game + layout.game._restoreGameRequested) || byte(game + layout.game._restartGameRequested) || byte(game + layout.game._mainMenuRequested)) return { available: false, reason: 'Original renderer: outside a supported module or a menu is active.' };
    const roomModule = ptr(game + layout.module._childObject);
    if (!roomModule) return { available: false, reason: 'Waiting for room 1001 or 1002 to finish loading.' };
    range(roomModule, this.allRooms ? layout.module.size : layout.roomModule.size);
    const sceneNum = this.allRooms ? undefined : uint(roomModule + layout.roomModule._sceneNum);
    if ((!this.allRooms && sceneNum > 1) || uint(roomModule + layout.module._sceneType) !== 0 || byte(roomModule + layout.module._done) || !ptr(roomModule + layout.module._childObject)) return { available: false, reason: 'Original renderer: outside an ordinary supported scene.' };
    this.inRoom = true;
    this.room = this.allRooms ? `Module${moduleNum}` : sceneNum === 0 ? 'Scene1001' : 'Scene1002';
    if (ptr(screen + layout.screen._smackerDecoder) || byte(screen + layout.screen._fullRefresh) || short(screen + layout.screen._yOffset) !== 0) return { available: false, room: this.room, reason: 'Original renderer: video or a special screen mode is active.' };
    const pending = ptr(screen + layout.screen._renderQueue);
    range(pending, layout.array.size);
    if (uint(pending + layout.array._size)) return { available: false, room: this.room, reason: 'Waiting for a completed drawing frame.' };
    const queue = ptr(screen + layout.screen._prevRenderQueue);
    if (!queue) return { available: false, room: this.room, reason: 'No completed render queue yet.' };
    range(queue, layout.array.size);
    const count = uint(queue + layout.array._size);
    const capacity = uint(queue + layout.array._capacity);
    if (count > 512 || count > capacity || capacity > 8192) throw new Error('Render adapter rejected the queue bounds.');
    if (!count) return { available: false, room: this.room, reason: 'The current output bypasses the ordinary render queue.' };
    const storage = ptr(queue + layout.array._storage);
    range(storage, count * layout.item.size);

    const surfaces = new Map();
    let pixels = 0;
    const surface = address => {
      if (surfaces.has(address)) return surfaces.get(address);
      range(address, layout.surface.size);
      const width = short(address + layout.surface.w);
      const height = short(address + layout.surface.h);
      const pitch = uint(address + layout.surface.pitch);
      const bpp = byte(address + layout.surface.bytesPerPixel);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || pitch < width || pitch > 8192 || bpp !== 1) throw new Error('Only bounded indexed surfaces are supported by this prototype.');
      const length = pitch * height;
      pixels += length;
      if (pixels > 8 * 1024 ** 2) throw new Error('Render adapter rejected an oversized surface set.');
      const start = ptr(address + layout.surface.pixels);
      range(start, length);
      const result = { address, width, height, pitch, pixels: heap.subarray(start, start + length) };
      surfaces.set(address, result);
      return result;
    };
    const items = [];
    for (let i = 0; i < count; i++) {
      const address = storage + i * layout.item.size;
      const field = layout.item;
      const item = {
        source: surface(ptr(address + field._surface)),
        destX: short(address + field._destX), destY: short(address + field._destY),
        srcX: short(address + field._srcX), srcY: short(address + field._srcY),
        width: short(address + field._width), height: short(address + field._height),
        transparent: byte(address + field._transparent) !== 0,
        alphaColor: byte(address + field._alphaColor), version: byte(address + field._version),
      };
      if (item.width <= 0 || item.height <= 0 || item.srcX < 0 || item.srcY < 0 || item.srcX + item.width > item.source.width || item.srcY + item.height > item.source.height) throw new Error('Render adapter rejected an invalid source rectangle.');
      const shadow = ptr(address + field._shadowSurface);
      if (shadow) item.shadow = surface(shadow);
      items.push(item);
    }
    const palette = ptr(screen + layout.screen._paletteData);
    if (!palette) return { available: false, room: this.room, reason: 'The current frame has no retained palette.' };
    range(palette, 1024);
    const back = surface(ptr(screen + layout.screen._backScreen));
    if (back.width !== 640 || back.height !== 480) throw new Error('Unexpected logical screen size.');
    let reference;
    if (includeReference) {
      reference = new Uint8Array(640 * 480);
      for (let y = 0; y < 480; y++) reference.set(back.pixels.subarray(y * back.pitch, y * back.pitch + 640), y * 640);
    }
    const scene = ptr(roomModule + layout.module._childObject);
    range(scene, layout.scene.size);
    const mouse = ptr(scene + layout.scene._mouseCursor);
    if (this.allRooms && !mouse) return { available: true, room: this.room, tick: uint(screen + layout.screen._ticks), items, palette: heap.subarray(palette, palette + 1024), reference, engine, screen };
    if (!mouse) return { available: false, room: this.room, reason: 'Original renderer: cursor is unavailable.' };
    range(mouse, layout.mouse.size);
    const shared = mouse + layout.sprite._surface;
    range(shared, layout.shared.size);
    const base = ptr(shared + layout.shared._pointer);
    range(base, layout.baseSurface.size);
    const cursorSurface = surface(ptr(base + layout.baseSurface._surface));
    if (cursorSurface.width !== 32 || cursorSurface.height !== 32) throw new Error('Unexpected native cursor dimensions.');
    const offset = mouse + layout.sprite._drawOffset;
    const hotspotX = -short(offset + layout.rect.x), hotspotY = -short(offset + layout.rect.y);
    if (Math.abs(hotspotX) > 32 || Math.abs(hotspotY) > 32) throw new Error('Render adapter rejected the cursor hotspot.');
    const cursor = { source: cursorSurface, visible: byte(base + layout.baseSurface._visible) !== 0, x: short(engine + layout.engine._mouseX), y: short(engine + layout.engine._mouseY), hotspotX, hotspotY };
    if (Number.isInteger(layout.scene._cursorFileHash)) cursor.resourceHash = uint(scene + layout.scene._cursorFileHash);
    return { available: true, room: this.room, tick: uint(screen + layout.screen._ticks), items, cursor, palette: heap.subarray(palette, palette + 1024), reference, engine, screen };
  }
}
