// Native window-look scenes, including conditional world/lighting/entrance states.
// Resource hashes identify source data, not replacement artwork or guessed geometry.
export const WINDOW_SCENES = [
  { module: 1000, scene: 2, resource: 'C084110C', room: 'Module1000-C084110C', state: 'first-room-window' },
  { module: 1300, scene: 2, resource: '01581A9C', room: 'Scene1303', state: 'balloon-window' },
  { module: 2200, scene: 47, resource: '83110287', room: 'Module2200-83110287', state: 'worlds-separate-lit', conditions: { V_WORLDS_JOINED: 0, V_LIGHTS_ON: 1 } },
  { module: 2200, scene: 47, resource: '83412B9D', room: 'Module2200-83412B9D', state: 'worlds-separate-dark', conditions: { V_WORLDS_JOINED: 0, V_LIGHTS_ON: 0 } },
  { module: 2200, scene: 47, resource: '48632087', room: 'Module2200-48632087', state: 'worlds-joined-lit', conditions: { V_WORLDS_JOINED: 1, V_LIGHTS_ON: 1 } },
  { module: 2200, scene: 47, resource: '08C74886', room: 'Module2200-08C74886', state: 'worlds-joined-dark', conditions: { V_WORLDS_JOINED: 1, V_LIGHTS_ON: 0 } },
  { module: 2400, scene: 7, resource: '81523218', room: 'Module2400-81523218', state: 'window-7' },
  { module: 2400, scene: 8, resource: '08100210', room: 'Module2400-08100210', state: 'window-8' },
  { module: 2400, scene: 9, resource: '8C020505', room: 'Module2400-8C020505', state: 'window-9' },
  { module: 2500, scene: 9, resource: 'C62A0645', room: 'Module2500-C62A0645', state: 'entrance-open', conditions: { V_ENTRANCE_OPEN: 1 } },
  { module: 2500, scene: 9, resource: '7A343546', room: 'Module2500-7A343546', state: 'entrance-closed', conditions: { V_ENTRANCE_OPEN: 0 } },
  { module: 2800, scene: 25, resource: '01600204', room: 'Module2800-01600204', state: 'lights-on', conditions: { V_SHRINK_LIGHTS_ON: 1 } },
  { module: 2800, scene: 25, resource: '08611204', room: 'Module2800-08611204', state: 'lights-off', conditions: { V_SHRINK_LIGHTS_ON: 0 } },
];

// A deliberate look inside another room, checked separately from outward windows.
export const RELATED_LOOK_SCENES = [
  { module: 2700, scene: 31, resource: '0220C041', room: 'Scene2732', state: 'peek-inside-bedroom', kind: 'look-inside' },
];
export const ALL_WINDOW_VIEWS = [...WINDOW_SCENES, ...RELATED_LOOK_SCENES];
