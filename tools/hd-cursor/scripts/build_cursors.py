# SPDX-License-Identifier: GPL-3.0-or-later
"""Run with Blender --background --disable-autoexec --python this.py -- [options].

Build seven genuine clay volumes using the preserved pointer's material/lights.
The input checkpoint is read-only; generated media stays in private storage.
"""
import argparse
import hashlib
import json
import math
import shutil
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DEFAULT_CHECKPOINT, DEFAULT_GESTURES, DEFAULT_OUTPUT, output_directory

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--checkpoint', type=Path, default=DEFAULT_CHECKPOINT)
parser.add_argument('--gestures', type=Path, default=DEFAULT_GESTURES,
                    help='Private shape recipe JSON; not supplied with the public source')
parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
OUT = output_directory(args.output)
SOURCE = args.checkpoint.resolve()
recipes = json.loads(args.gestures.read_text())
if recipes.get('version') != 1 or set(recipes.get('rows', {})) != {'0', '1', '2', '3', '5', '6'}:
    raise ValueError('Gesture recipes must have version 1 and rows 0, 1, 2, 3, 5, 6')
for name in ['cursor-fitted.blend', 'scene-metadata.json', *(f'f{i}-clay-1024.png' for i in range(3))]:
    if not (SOURCE / name).is_file():
        raise FileNotFoundError(f'Missing checkpoint file: {SOURCE / name}. Supply an authorized local checkpoint with --checkpoint; it is not bundled.')
if OUT == SOURCE or OUT.is_relative_to(SOURCE) or SOURCE.is_relative_to(OUT):
    raise ValueError('Checkpoint and output directories must not overlap')
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(SOURCE / 'cursor-fitted.blend'), use_scripts=False)
template = bpy.context.scene
metadata = json.loads((SOURCE / 'scene-metadata.json').read_text())
pointer = bpy.data.objects[metadata['poses'][0]['object']]
material = bpy.data.materials[metadata['material']]
lighting = [obj for obj in template.objects if obj.type in {'LIGHT', 'CAMERA'}]
ROWS = [('forward', (15, 5)), ('restricted', (17, 25)), ('down', (17, 30)),
        ('up', (14, 1)), ('pointer', (3, 7)), ('right', (30, 18)), ('left', (1, 18))]


def tube(points, radii, sides=64):
    """Closed circular sections along a 3D centerline, never a mask extrusion."""
    points = np.asarray(points, dtype=float)
    vertices, faces = [], []
    for i, (point, radius) in enumerate(zip(points, radii)):
        tangent = points[min(i + 1, len(points) - 1)] - points[max(0, i - 1)]
        tangent /= np.linalg.norm(tangent)
        u = np.cross(tangent, [0., 0., 1.])
        u /= np.linalg.norm(u)
        v = np.cross(tangent, u)
        for side in range(sides):
            angle = 2 * math.pi * side / sides
            x, y, z = point + radius * (math.cos(angle) * u + math.sin(angle) * v)
            vertices.append((float(x - 16), float(16 - y), float(z)))
    for ring in range(len(points) - 1):
        for side in range(sides):
            a, b = ring * sides + side, ring * sides + (side + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces += [tuple(reversed(range(sides))), tuple((len(points) - 1) * sides + j for j in range(sides))]
    mesh = bpy.data.meshes.new('Round clay construction')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def arrow(tip, base, end, radius, stem_radius=3.2, bend=None):
    tip, base, end = map(lambda p: np.array(p, dtype=float), (tip, base, end))
    t = np.linspace(0, 1, 56)
    axis = base - tip
    length = np.linalg.norm(axis)
    axis /= length
    points = tip + t[:, None] * (base - tip)
    radii = np.sqrt((radius * t) ** 2 + 1.3 * t * length * np.exp(-t * length / 1.4))
    radii[0] = .04
    for angle in np.linspace(0, math.pi / 2, 14)[1:]:
        points = np.vstack([points, base + axis * .7 * math.sin(angle)])
        radii = np.append(radii, radius - .7 * (1 - math.cos(angle)))
    parts = [tube(points, radii)]
    # A quadratic centerline allows the two side arrows to bend as real solids.
    control = np.asarray(bend if bend is not None else (base + end) / 2)
    points = (1-t[:, None])**2 * base + 2*(1-t[:, None])*t[:, None]*control + t[:, None]**2*end
    radii = stem_radius + .7 * t
    tail_axis = points[-1] - points[-2]
    tail_axis /= np.linalg.norm(tail_axis)
    for angle in np.linspace(0, math.pi / 2 - .001, 16)[1:]:
        points = np.vstack([points, end + tail_axis * 1.1 * math.sin(angle)])
        radii = np.append(radii, (stem_radius + .7) * math.cos(angle))
    parts.append(tube(points, radii))
    return parts


def build(row):
    recipe = recipes['rows'][str(row)]
    if recipe['primitive'] == 'flared-rod':
        # A circular rod with flared ends, described entirely by input parameters.
        p = recipe['parameters']
        t = np.linspace(0, 1, 120)
        start, end = np.array(p['start']), np.array(p['end'])
        points = start + t[:, None]*(end-start)
        radii = p['shaftRadius'] + p['flareRadius']*(np.exp(-t*p['falloff']) + np.exp(-(1-t)*p['falloff']))
        axis = (end-start)/np.linalg.norm(end-start)
        for start in (True, False):
            index = 0 if start else -1
            anchor, radius = points[index].copy(), radii[index]
            angles = np.linspace(.01, math.pi/2, 16)
            cap = np.array([anchor + axis*(-1 if start else 1)*p['capLength']*math.cos(a) for a in angles])
            cr = radius*np.sin(angles)
            if start:
                points, radii = np.vstack([cap, points]), np.r_[cr, radii]
            else:
                points, radii = np.vstack([points, cap[::-1]]), np.r_[radii, cr[::-1]]
        parts = [tube(points, radii)]
    elif recipe['primitive'] == 'arrow':
        parts = arrow(**recipe['parameters'])
    else:
        raise ValueError(f'Unknown primitive for row {row}')
    return parts, recipe['junction'], recipe['tail']


records, scenes = [], []
for row, (name, hotspot) in enumerate(ROWS):
    scene = bpy.data.scenes.new(f'HD cursor r{row} {name}')
    bpy.context.window.scene = scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples, scene.cycles.seed = 128, 17
    scene.cycles.use_denoising = scene.cycles.use_animated_seed = False
    scene.render.threads_mode, scene.render.threads = 'FIXED', 4
    scene.world = template.world
    for obj in lighting:
        scene.collection.objects.link(obj)
    scene.camera = template.camera
    scene.view_settings.view_transform, scene.view_settings.look = 'Standard', 'None'
    scene.render.resolution_x = scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '16'
    scene.render.fps, scene.render.fps_base = 1000, 82
    scene.frame_start, scene.frame_end = 1, 3
    scene['logicalSize'], scene['hotspot'], scene['row'] = [32, 32], hotspot, row
    if row == 4:
        obj = pointer.copy()
        obj.data = pointer.data.copy()
        scene.collection.objects.link(obj)
    else:
        parts, junction, tail = build(row)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in parts:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = parts[0]
        if len(parts) > 1:
            bpy.ops.object.join()
        obj = parts[0]
        obj.data.remesh_voxel_size = .09
        bpy.ops.object.voxel_remesh()
        modifier = obj.modifiers.new('Soften fused clay joint', 'SMOOTH')
        modifier.factor, modifier.iterations = .25, 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for face in obj.data.polygons:
            face.use_smooth = True
        vertices = np.array([tuple(v.co) for v in obj.data.vertices])
        # Deform only the free tail, keeping the arrowhead and hotspot stable.
        xy = np.column_stack([vertices[:, 0] + 16, 16 - vertices[:, 1]])
        axis = np.array(tail, dtype=float) - junction
        length = np.linalg.norm(axis)
        axis /= length
        weight = np.clip(((xy-junction) @ axis - 4) / max(length-4, 1), 0, 1)
        weight = weight**2 * (3 - 2*weight)
        direction = np.array([-axis[1], -axis[0], 0])
        obj.shape_key_add(name='Basis')
        for ordinal, sign in ((1, -1), (2, 1)):
            key = obj.shape_key_add(name=f'Tail pose {ordinal}')
            key.data.foreach_set('co', (vertices + sign*.65*weight[:, None]*direction).ravel())
            for frame in (1, 2, 3):
                key.value = float(frame == ordinal+1)
                key.keyframe_insert('value', frame=frame)
    obj.name = f'Clay cursor r{row} {name}'
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    nonmanifold = sum(not edge.is_manifold for edge in bm.edges)
    volume = bm.calc_volume(signed=False)
    bm.free()
    if nonmanifold or volume <= 0:
        raise ValueError(f'Invalid solid for row {row}: {nonmanifold}, {volume}')
    folder = OUT / 'sprites' / f'r{row}-{name}'
    folder.mkdir(parents=True, exist_ok=True)
    for ordinal in range(3):
        scene.frame_set(ordinal + 1)
        target = folder / f'f{ordinal}-clay-1024.png'
        if row == 4:
            shutil.copyfile(SOURCE / f'f{ordinal}-clay-1024.png', target)
        else:
            scene.render.filepath = str(target)
            bpy.ops.render.render(write_still=True)
    scene.frame_set(1)
    records.append(dict(row=row, name=name, hotspot=list(hotspot), exportHotspot=[v*4 for v in hotspot],
                        scene=scene.name, object=obj.name, vertices=len(obj.data.vertices),
                        nonManifoldEdges=nonmanifold, volume=volume))
    scenes.append(scene)
    print(f'HD_CURSOR_ROW_COMPLETE {row} {name}', flush=True)

# Keep only the pack scenes; never save into the original checkpoint.
for scene in list(bpy.data.scenes):
    if scene not in scenes:
        bpy.data.scenes.remove(scene)
bpy.context.window.scene = scenes[4]
for action in bpy.data.actions:
    curves = list(action.fcurves) if hasattr(action, 'fcurves') else [
        curve for layer in action.layers for strip in layer.strips
        for bag in strip.channelbags for curve in bag.fcurves]
    for curve in curves:
        for key in curve.keyframe_points:
            key.interpolation = 'CONSTANT'
bpy.ops.outliner.orphans_purge(do_recursive=True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'hd-cursor.blend'), compress=True)
(OUT / 'build.json').write_text(json.dumps(dict(version=1, revision='clay-seven-gestures-v1',
    blender=bpy.app.version_string, sourceSHA256=hashlib.sha256((SOURCE/'cursor-fitted.blend').read_bytes()).hexdigest(),
    recipesSHA256=hashlib.sha256(args.gestures.read_bytes()).hexdigest(),
    logicalSize=[32, 32], masterSize=[1024, 1024], cellSize=128, phaseMapping=[0, 0, 1, 1, 2, 2],
    poseDurationMs=82, scope='Seven standard gestures, not scene-specific palette bindings',
    animation='Authored fixed-head tail swing; not recovered original motion', rows=records), indent=2)+'\n')
