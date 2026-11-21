#!/usr/bin/env python3
"""Generate an original ION Flexity Freedom GLB from scratch (Blender 4.3+).

Run from the repo root:

    blender -b -P tools/blender/build_flexity.py -- --out public/models/flexity.glb

The mesh is original work. The shell is matched to CC0 ION Flexity Freedom photographs (514 side,
504B / 501B front and 3/4): blunt rounded nose, wraparound windscreen,
per-module window/door layout, low roof HVAC and bogie skirts.
Proportions follow the ION Flexity Freedom (30.8 x 2.65 x 3.6 m, five modules)
and the CC0 Wikimedia 514 / 507 service-livery photos. Tribute livery only:
no ION, GRT, or Region marks. Fleet number 514. No red/magenta accent — the
CC0 service-livery photos (514, 507, and the booledozer 2019 opening-day set)
do not show one.

Coordinate convention inside this script is Three.js / the sim
(X right, Y up, Z forward). Vertices are stored in Blender space
(X right, Y forward, Z up) via ``to_b()``. The glTF exporter's Y-up
conversion plus Three's GLTFLoader then restore Z-forward Y-up.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
from array import array
from typing import Iterable, Sequence

import bpy
import bmesh
from mathutils import Vector

# ---------------------------------------------------------------------------
# Dimensions — keep in lockstep with src/game/Clearances.ts and Vehicles.ts
# ---------------------------------------------------------------------------

LRV_LENGTH = 30.8
LRV_WIDTH = 2.65
LRV_HEIGHT = 3.6
LRV_FLOOR = 0.33
NOSE_LEN = 1.72
OCS_WIRE_STREET = 5.5
FLEET_NO = "514"

SCALE = LRV_LENGTH / 32.366
MODULES = [
    {"len": 6.763 * SCALE, "kind": "truck", "name": "A-cab"},
    {"len": 7.670 * SCALE, "kind": "suspended", "name": "B"},
    {"len": 3.500 * SCALE, "kind": "truck", "name": "C-centre"},
    {"len": 7.670 * SCALE, "kind": "suspended", "name": "D"},
    {"len": 6.763 * SCALE, "kind": "truck", "name": "E-cab"},
]

# Body profile
HALF_W = LRV_WIDTH * 0.495
Y_BOT = 0.16
Y_ROOF = LRV_HEIGHT - 0.22
R_SHOULDER = 0.28
R_BOTTOM = 0.10
TUMBLE = 0.08

# Side proportions from the 514 side photo and the v4 brief: the white belt is
# about the lower 40% of the body side, the skirt is a thin black line, and
# the glass runs from the belt to just under a thin blue roof cap.
Y_SKIRT = 0.30
Y_BELT = 1.46
Y_WIN_TOP = Y_ROOF - 0.12
Y_WIN_MID = 0.5 * (Y_BELT + Y_WIN_TOP)
Y_WIN_H = Y_WIN_TOP - Y_BELT
PILLAR = 0.11
# Cab front: nearly vertical, slight rake, strongly rounded corners, bowed
# plan, and tumblehome toward a soft curved roof (504B head-on / 501B 3/4).
R_FRONT = 0.68
FRONT_RAKE = 0.27
FRONT_BOW = 0.11
FRONT_TUMBLE = 0.24          # extra inward taper of the face toward the roof
BLUE_BAND = 0.40             # faired C-band width, metres (thick in 3/4 like 501B)
Y_FRONT_GLASS_TOP = Y_ROOF - 0.36
Y_PANEL_BOT = 0.80           # black lamp / number panel under the glass
Y_PANEL_TOP = Y_BELT

# Livery colours are stored as sRGB. paint_livery writes them into sRGB-tagged
# images; make_mat converts untextured Base Color to scene-linear so the glTF
# baseColorFactor does not wash (the old #1a74c8 stuffed in as linear read as
# a light cyan). ION royal blue is a deep #1f4fa0, not a sky cyan.
COL_BODY = (0.902, 0.918, 0.937)       # #e6eaef
COL_SKIRT = (0.110, 0.114, 0.125)      # #1c1d20
COL_BAND = (0.165, 0.173, 0.192)       # #2a2c31
COL_BLUE = (0x1F / 255.0, 0x4F / 255.0, 0xA0 / 255.0)   # #1f4fa0
COL_BLUE_DK = (0x1A / 255.0, 0x3F / 255.0, 0x86 / 255.0)  # #1a3f86
COL_NUMBER = (0.173, 0.200, 0.235)     # #2c333c

# Side UVs live in v=0..V_SPLIT; roof island in v=V_SPLIT..1 (pure blue, no swoosh).
V_SPLIT = 0.85


# ---------------------------------------------------------------------------
# Coordinates, scene, materials
# ---------------------------------------------------------------------------

def to_b(x: float, y: float, z: float) -> tuple[float, float, float]:
    """Three.js (x, y_up, z_fwd) → Blender (x, y_fwd, z_up)."""
    return (x, z, y)


def from_b(co) -> tuple[float, float, float]:
    return (co.x, co.z, co.y)


def parse_args(argv: list[str]) -> argparse.Namespace:
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    p = argparse.ArgumentParser(prog="build_flexity")
    p.add_argument("--out", default="public/models/flexity.glb")
    return p.parse_args(argv)


def reset_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                 bpy.data.cameras, bpy.data.lights, bpy.data.collections):
        for block in list(coll):
            if block.name == "Collection" and isinstance(block, bpy.types.Collection):
                continue
            try:
                coll.remove(block)
            except Exception:
                pass
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def srgb_to_linear(c: float) -> float:
    """sRGB channel in 0..1 → scene-linear (IEC 61966-2-1)."""
    c = max(0.0, min(1.0, c))
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def make_mat(
    name: str,
    color: tuple[float, float, float],
    metallic: float = 0.4,
    roughness: float = 0.4,
    alpha: float = 1.0,
    image: bpy.types.Image | None = None,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    # Principled Base Color and glTF baseColorFactor are scene-linear.
    lin = tuple(srgb_to_linear(c) for c in color)
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    mat.diffuse_color = (*lin, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = "BLEND"
        try:
            mat.use_backface_culling = False
        except Exception:
            pass
        try:
            mat.shadow_method = "NONE"
        except Exception:
            pass
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.location = (-320, 200)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def new_empty(name: str, loc, parent=None, rot_z: float = 0.0) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.12
    obj.empty_display_type = "PLAIN_AXES"
    obj.location = to_b(*loc)
    if rot_z:
        obj.rotation_euler = (0.0, 0.0, rot_z)
    if parent is not None:
        obj.parent = parent
    bpy.context.collection.objects.link(obj)
    return obj


def mesh_from_bm(name: str, bm: bmesh.types.BMesh) -> bpy.types.Mesh:
    try:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    except Exception:
        pass
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    mesh.update()
    mesh.shade_smooth()
    return mesh


def new_obj(name: str, mesh: bpy.types.Mesh, mat=None, parent=None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, mesh)
    if mat is not None:
        mesh.materials.append(mat)
    if parent is not None:
        obj.parent = parent
    bpy.context.collection.objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# Primitive helpers (sizes / positions in Three.js metres)
# ---------------------------------------------------------------------------

def add_box(name, w, h, d, x, y, z, mat, parent=None) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= w
        v.co.y *= d
        v.co.z *= h
    mesh = mesh_from_bm(name, bm)
    bm.free()
    obj = new_obj(name, mesh, mat, parent)
    obj.location = Vector(to_b(x, y, z))
    return obj


def add_front_plate(name, w, h, x, y, z, front, mat, parent) -> bpy.types.Object:
    """UV-mapped plate facing ±Z (Three.js), used for the chin fleet number."""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    corners = [
        (x - w * 0.5, y - h * 0.5, z),
        (x + w * 0.5, y - h * 0.5, z),
        (x + w * 0.5, y + h * 0.5, z),
        (x - w * 0.5, y + h * 0.5, z),
    ]
    verts = [bm.verts.new(to_b(*p)) for p in corners]
    f = bm.faces.new(verts if front > 0 else list(reversed(verts)))
    uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    if front < 0:
        uvs = list(reversed(uvs))
    for loop, uv in zip(f.loops, uvs):
        loop[uv_layer].uv = uv
    mesh = mesh_from_bm(name, bm)
    bm.free()
    return new_obj(name, mesh, mat, parent)


def add_cyl(name, radius, depth, x, y, z, axis, mat, parent=None, segs=16) -> bpy.types.Object:
    """axis is in Three.js ('x' / 'y' / 'z'). depth is length along that axis."""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False,
        segments=segs, radius1=radius, radius2=radius, depth=depth,
    )
    # create_cone is along Blender +Z
    if axis == "x":
        bmesh.ops.rotate(bm, verts=bm.verts,
                         cent=(0, 0, 0),
                         matrix=_rot(math.pi / 2, "Y"))
    elif axis == "z":
        bmesh.ops.rotate(bm, verts=bm.verts,
                         cent=(0, 0, 0),
                         matrix=_rot(math.pi / 2, "X"))
    # axis == 'y' (up) is already +Z in Blender
    mesh = mesh_from_bm(name, bm)
    bm.free()
    obj = new_obj(name, mesh, mat, parent)
    obj.location = Vector(to_b(x, y, z))
    return obj


def add_uvsphere(name, rx, ry, rz, x, y, z, mat, parent=None, segs=16, rings=8) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co.x *= rx
        v.co.y *= rz
        v.co.z *= ry
    mesh = mesh_from_bm(name, bm)
    bm.free()
    obj = new_obj(name, mesh, mat, parent)
    obj.location = Vector(to_b(x, y, z))
    return obj


def add_rounded_box(name, w, h, d, x, y, z, mat, parent=None, radius=0.06, seg=3) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= max(0.02, w - 2 * radius)
        v.co.y *= max(0.02, d - 2 * radius)
        v.co.z *= max(0.02, h - 2 * radius)
    bm.edges.ensure_lookup_table()
    try:
        bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts),
                        offset=radius, segments=seg, affect="EDGES")
    except Exception:
        pass
    mesh = mesh_from_bm(name, bm)
    bm.free()
    obj = new_obj(name, mesh, mat, parent)
    obj.location = Vector(to_b(x, y, z))
    return obj


def _rot(angle: float, axis: str):
    from mathutils import Matrix
    if axis == "X":
        return Matrix.Rotation(angle, 3, "X")
    if axis == "Y":
        return Matrix.Rotation(angle, 3, "Y")
    return Matrix.Rotation(angle, 3, "Z")


# ---------------------------------------------------------------------------
# Body profile + loft
# ---------------------------------------------------------------------------

def body_profile(n_arc=16, n_side=10) -> list[tuple[float, float]]:
    x_bot = HALF_W
    x_top = max(0.2, HALF_W - TUMBLE)
    pts: list[tuple[float, float]] = [(0.0, Y_BOT), (x_bot - R_BOTTOM, Y_BOT)]

    def arc(cx, cy, r, a0, a1, n):
        for i in range(1, n + 1):
            a = a0 + (a1 - a0) * (i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))

    arc(x_bot - R_BOTTOM, Y_BOT + R_BOTTOM, R_BOTTOM, -math.pi / 2, 0, n_arc)
    y_side0 = Y_BOT + R_BOTTOM
    y_side1 = Y_ROOF - R_SHOULDER
    for i in range(1, n_side + 1):
        t = i / n_side
        y = y_side0 + (y_side1 - y_side0) * t
        x = x_bot + (x_top - x_bot) * t
        pts.append((x, y))
    arc(x_top - R_SHOULDER, Y_ROOF - R_SHOULDER, R_SHOULDER, 0, math.pi / 2, n_arc)
    pts.append((0.0, Y_ROOF))
    right = pts[1:]
    for x, y in reversed(right):
        if x == 0:
            continue
        pts.append((-x, y))
    return pts


def scale_profile(src: list[tuple[float, float]], sx: float, y_bot: float, y_roof: float):
    y0 = min(p[1] for p in src)
    y1 = max(p[1] for p in src)
    span = max(1e-6, y1 - y0)
    out = []
    for x, y in src:
        t = (y - y0) / span
        out.append((x * sx, y_bot + t * (y_roof - y_bot)))
    return out


def _uv(x: float, y: float, u_len: float, flip_u: bool) -> tuple[float, float]:
    """Side island in v=[0, V_SPLIT]; roof island in v=[V_SPLIT, 1] (no swoosh)."""
    v_h = (y - Y_BOT) / max(1e-6, Y_ROOF - Y_BOT)
    u = (1.0 - u_len) if flip_u else u_len
    u = max(0.0, min(1.0, u))
    # Roof: high and near the centre line — keep it off the side swoosh.
    if y > Y_ROOF - 0.10 and abs(x) < HALF_W - TUMBLE - 0.12:
        v = V_SPLIT + (1.0 - V_SPLIT) * min(1.0, abs(x) / max(0.2, HALF_W))
        return u, max(V_SPLIT, min(1.0, v))
    return u, max(0.0, min(V_SPLIT - 1e-4, v_h * V_SPLIT))


def _face_is_front(p0, p1, q0, z0, z1, u0: float = 0.0, u1: float = 0.0) -> bool:
    """True for nose faces that are not the side walls (A-pillar).

    The brow and chin point mostly up/down, so a pure |nz| vs |nx| test
    left them on the side UV island and the swoosh zebra-striped the front.
    """
    if max(u0, u1) < 0.70:
        return False
    ax, ay, az = p1[0] - p0[0], p1[1] - p0[1], 0.0
    bx, by, bz = q0[0] - p0[0], q0[1] - p0[1], z1 - z0
    nx = ay * bz - az * by
    ny = az * bx - ax * bz
    nz = ax * by - ay * bx
    # Side wall = dominant ±X. Front, brow and chin all get the clean UV.
    return abs(nx) <= max(abs(ny), abs(nz)) * 1.05


def loft_shell(
    rings: list[dict],
    cap_start: bool,
    cap_end: bool,
) -> bmesh.types.BMesh:
    """rings: {pts:[(x,y)], z:float, u:float}"""
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    n = len(rings[0]["pts"])
    # verts[s][i]
    verts: list[list] = []
    for r in rings:
        row = []
        for x, y in r["pts"]:
            row.append(bm.verts.new(to_b(x, y, r["z"])))
        verts.append(row)
    bm.verts.ensure_lookup_table()

    def set_loop_uv(face, corners):
        # corners: list of (vert, u, v) in face winding order
        for loop, (_v, u, v) in zip(face.loops, corners):
            loop[uv_layer].uv = (u, v)

    for s in range(len(rings) - 1):
        r0, r1 = rings[s], rings[s + 1]
        for i in range(n):
            j = (i + 1) % n
            p0 = r0["pts"][i]
            p1 = r0["pts"][j]
            q0 = r1["pts"][i]
            q1 = r1["pts"][j]
            flip = (p0[0] + p1[0]) / 2.0 > 0
            u0 = r0["u"]
            u1 = r1["u"]
            # The whole nose loft (past the body/nose joint) uses a clean mid-body
            # u so the painted swoosh cannot zebra-stripe the brow, glass or chin.
            # The A-pillar on the nose is a separate 3D ribbon (see _add_swoosh).
            if max(r0["u"], r1["u"]) > 0.70:
                u0 = u1 = 0.18
                flip = False
            v00 = _uv(p0[0], p0[1], u0, flip)
            v10 = _uv(p1[0], p1[1], u0, flip)
            v01 = _uv(q0[0], q0[1], u1, flip)
            v11 = _uv(q1[0], q1[1], u1, flip)
            try:
                f = bm.faces.new((verts[s][i], verts[s][j], verts[s + 1][j], verts[s + 1][i]))
            except ValueError:
                continue
            set_loop_uv(f, [
                (verts[s][i], *v00),
                (verts[s][j], *v10),
                (verts[s + 1][j], *v11),
                (verts[s + 1][i], *v01),
            ])

    def cap(ring_idx: int, flip: bool):
        r = rings[ring_idx]
        y0 = min(p[1] for p in r["pts"])
        y1 = max(p[1] for p in r["pts"])
        c = bm.verts.new(to_b(0.0, (y0 + y1) * 0.5, r["z"]))
        row = verts[ring_idx]
        for i in range(n):
            a, b = row[i], row[(i + 1) % n]
            try:
                f = bm.faces.new((c, b, a) if flip else (c, a, b))
            except ValueError:
                continue
            # End caps: use a clean mid-body u so a nose cap never samples the swoosh.
            u = 0.18
            pa = r["pts"][i]
            pb = r["pts"][(i + 1) % n]
            uc, vc = _uv(0.0, (y0 + y1) * 0.5, u, False)
            ua, va = _uv(pa[0], pa[1], u, False)
            ub, vb = _uv(pb[0], pb[1], u, False)
            if flip:
                set_loop_uv(f, [(c, uc, vc), (b, ub, vb), (a, ua, va)])
            else:
                set_loop_uv(f, [(c, uc, vc), (a, ua, va), (b, ub, vb)])

    if cap_start:
        cap(0, True)
    if cap_end:
        cap(len(rings) - 1, False)
    return bm


# ---------------------------------------------------------------------------
# Livery image
# ---------------------------------------------------------------------------

FONT_5X7 = {
    "0": ["01110", "10001", "10001", "10011", "10101", "11001", "01110"],
    "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
    "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
    "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
}


def _new_pixels(w: int, h: int, color) -> array:
    px = array("f", [0.0]) * (w * h * 4)
    r, g, b = color
    for i in range(0, w * h * 4, 4):
        px[i] = r
        px[i + 1] = g
        px[i + 2] = b
        px[i + 3] = 1.0
    return px


def _pset(px: array, w: int, h: int, x: int, y: int, c) -> None:
    if x < 0 or y < 0 or x >= w or y >= h:
        return
    i = (y * w + x) * 4
    px[i] = c[0]
    px[i + 1] = c[1]
    px[i + 2] = c[2]
    px[i + 3] = 1.0


def _fill_rect(px, w, h, x0, y0, x1, y1, c) -> None:
    x0, x1 = max(0, int(x0)), min(w, int(x1))
    y0, y1 = max(0, int(y0)), min(h, int(y1))
    for y in range(y0, y1):
        row = y * w * 4
        for x in range(x0, x1):
            i = row + x * 4
            px[i] = c[0]
            px[i + 1] = c[1]
            px[i + 2] = c[2]
            px[i + 3] = 1.0


def _stamp_disk(px, w, h, cx, cy, radius, c) -> None:
    r = int(math.ceil(radius))
    r2 = radius * radius
    for y in range(int(cy) - r, int(cy) + r + 1):
        for x in range(int(cx) - r, int(cx) + r + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                _pset(px, w, h, x, y, c)


def _draw_curve(px, w, h, pts, radius, c, samples=80) -> None:
    """Catmull-Rom-ish polyline stamped with disks."""
    if len(pts) < 2:
        return
    # densify
    dense = []
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        steps = max(4, int(samples * (abs(x1 - x0) + abs(y1 - y0)) / (w + h)))
        for k in range(steps):
            t = k / steps
            dense.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    dense.append(pts[-1])
    for x, y in dense:
        _stamp_disk(px, w, h, x, y, radius, c)


def _draw_text(px, w, h, text: str, u: float, v: float, scale: int, c, origin_uv=True) -> None:
    """Draw 5x7 bitmap text. (u,v) is the left-middle of the string in UV space."""
    gw, gh = 5, 7
    gap = 1
    tw = len(text) * (gw + gap) - gap
    x0 = int(u * w)
    y_mid = int(v * h)
    x0 = x0
    y0 = y_mid - (gh * scale) // 2
    for ci, ch in enumerate(text):
        glyph = FONT_5X7.get(ch)
        if not glyph:
            continue
        for row, bits in enumerate(glyph):
            # glyph row 0 is the top of the character; pixel y grows up
            yy = y0 + (gh - 1 - row) * scale
            for col, bit in enumerate(bits):
                if bit != "1":
                    continue
                xx = x0 + ci * (gw + gap) * scale + col * scale
                _fill_rect(px, w, h, xx, yy, xx + scale, yy + scale, c)


def paint_livery(kind: str, w: int = 2048, h: int = 1024) -> bpy.types.Image:
    px = _new_pixels(w, h, COL_BODY)
    import random
    rng = random.Random(514 if kind != "cabE" else 507)
    for _ in range(1800):
        y = rng.randrange(h)
        boost = 0.04 + rng.random() * 0.07
        c = (min(1, COL_BODY[0] + boost), min(1, COL_BODY[1] + boost), min(1, COL_BODY[2] + boost))
        _fill_rect(px, w, h, 0, y, w, y + 1, c)

    side_h = int(V_SPLIT * h)
    # Very thin charcoal skirt — the window band is real glass.
    skirt_v = (Y_SKIRT - Y_BOT) / max(1e-6, Y_ROOF - Y_BOT)
    _fill_rect(px, w, h, 0, 0, w, int(skirt_v * side_h), COL_SKIRT)
    # Thin blue roof lip only, so the cap reads as a defined edge, not a thick band.
    _fill_rect(px, w, h, 0, int(0.955 * side_h), w, side_h, COL_BLUE)
    _fill_rect(px, w, h, 0, int(0.950 * side_h), w, int(0.960 * side_h), COL_BLUE_DK)
    # Roof island: solid blue, no swoosh (the A-pillar band is 3D, on the side).
    _fill_rect(px, w, h, 0, side_h, w, h, COL_BLUE)

    if kind in ("cabA", "cabE"):
        suffix = "A" if kind == "cabA" else "B"
        # Fleet number on the cab side, in the white belt.
        belt_v = (0.5 * (Y_SKIRT + Y_BELT) - Y_BOT) / max(1e-6, Y_ROOF - Y_BOT)
        _draw_text(px, w, h, f"{FLEET_NO}{suffix}", 0.55, belt_v * V_SPLIT, 9, COL_NUMBER)

    img = bpy.data.images.new(f"livery-{kind}", width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(px)
    img.pack()
    return img

def paint_door(w: int = 256, h: int = 512) -> bpy.types.Image:
    # Black plug-door skin; the two glass panes are real geometry.
    px = _new_pixels(w, h, (0.07, 0.072, 0.078))
    _fill_rect(px, w, h, 8, 8, w - 8, 28, (0.10, 0.10, 0.11))
    img = bpy.data.images.new("livery-door", width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(px)
    img.pack()
    return img


def recess_door_region(bm: bmesh.types.BMesh, side: float, door_z: float,
                       door_half: float, y0: float, y1: float, depth: float = 0.09) -> None:
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        x, y, z = from_b(v.co)
        if x * side <= 0:
            continue
        if not (y0 <= y <= y1):
            continue
        if abs(z - door_z) > door_half + 0.06:
            continue
        # falloff near the border so the recess eases in
        tz = 1.0 - min(1.0, max(0.0, (abs(z - door_z) - door_half + 0.04) / 0.10))
        ty = 1.0 - min(1.0, max(0.0, (max(y0 - y + 0.04, y - y1 + 0.04, 0.0)) / 0.10))
        t = max(0.0, min(1.0, tz * ty))
        if t <= 0:
            continue
        v.co.x -= side * depth * t


def _face_centroid(f) -> tuple[float, float, float]:
    sx = sy = sz = 0.0
    for v in f.verts:
        x, y, z = from_b(v.co)
        sx += x
        sy += y
        sz += z
    n = max(1, len(f.verts))
    return sx / n, sy / n, sz / n


def collect_faces(bm, pred) -> list:
    return [f for f in bm.faces if pred(*_face_centroid(f))]


def extract_faces_as_glass(bm: bmesh.types.BMesh, faces: list, bulge: float = 0.0,
                           offset: float = 0.018) -> bmesh.types.BMesh | None:
    if not faces:
        return None
    # Inset to leave a frame on the body, then copy the inner faces.
    try:
        ret = bmesh.ops.inset_region(
            bm, faces=faces, thickness=0.016, depth=0.0, use_boundary=True, use_even_offset=True,
        )
        inner = list(ret.get("faces") or faces)
    except Exception:
        inner = list(faces)

    # Copy inner faces into a new bmesh before deleting.
    glass = bmesh.new()
    uv_src = bm.loops.layers.uv.get("UVMap")
    uv_dst = glass.loops.layers.uv.new("UVMap") if uv_src else None
    vmap = {}
    for f in inner:
        vs = []
        for v in f.verts:
            if v not in vmap:
                nv = glass.verts.new(v.co)
                vmap[v] = nv
            vs.append(vmap[v])
        try:
            nf = glass.faces.new(vs)
        except ValueError:
            continue
        if uv_src and uv_dst:
            for ls, ld in zip(f.loops, nf.loops):
                ld[uv_dst].uv = ls[uv_src].uv.copy()

    # Offset + optional centre bulge along average outward normal (in Blender space).
    glass.verts.ensure_lookup_table()
    glass.faces.ensure_lookup_table()
    try:
        bmesh.ops.recalc_face_normals(glass, faces=glass.faces)
    except Exception:
        pass
    # Per-vert offset
    for v in glass.verts:
        # average normal of adjacent faces
        nrm = Vector((0, 0, 0))
        for f in v.link_faces:
            nrm += f.normal
        if nrm.length < 1e-8:
            continue
        nrm.normalize()
        extra = 0.0
        if bulge > 0:
            x, y, z = from_b(v.co)
            # bulge more near the middle of the windscreen
            extra = bulge * max(0.0, 1.0 - (abs(x) / (HALF_W + 1e-6)) ** 2)
        v.co += nrm * (offset + extra)

    try:
        bmesh.ops.delete(bm, geom=inner, context="FACES")
    except Exception:
        pass
    return glass


# ---------------------------------------------------------------------------
# Module builders
# ---------------------------------------------------------------------------

def polish_shell(obj: bpy.types.Object, bevel_width: float = 0.010, bevel_seg: int = 2) -> None:
    """Bevel sharp panel edges, smooth shading, weighted normals."""
    if obj is None or obj.type != "MESH":
        return
    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    try:
        bpy.ops.object.shade_smooth()
    except Exception:
        pass
    bev = obj.modifiers.new("shellBevel", "BEVEL")
    bev.width = bevel_width
    bev.segments = bevel_seg
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(30)
    try:
        bev.miter_outer = "MITER_ARC"
    except Exception:
        pass
    try:
        bev.affect = "EDGES"
    except Exception:
        pass
    wn = obj.modifiers.new("shellWN", "WEIGHTED_NORMAL")
    try:
        wn.mode = "FACE_AREA_WITH_ANGLE"
    except Exception:
        pass
    try:
        wn.keep_sharp = True
        wn.weight = 50
    except Exception:
        pass
    for mod_name in (bev.name, wn.name):
        try:
            bpy.context.view_layer.objects.active = obj
            with bpy.context.temp_override(object=obj, active_object=obj):
                bpy.ops.object.modifier_apply(modifier=mod_name)
        except Exception as exc:
            print(f"  polish apply {mod_name} on {obj.name} failed: {exc}")
    obj.select_set(False)


def _windscreen_surface(front: int, z_joint: float, nu: int = 26, nv: int = 16,
                        offset: float = 0.0):
    """Wraparound Freedom windscreen sitting *on* the nose skin, slightly outboard.

    v=0 at the glass / black-valance belt, v=1 at the brow under the roof lip.
    Forward placement follows the body loft so the boolean actually cuts the
    shell and the glass is not buried inside it.
    """
    y_belt, y_brow = 1.16, Y_ROOF - 0.12
    width = HALF_W - 0.05
    r_top = 0.42
    r_plan = 1.55
    rows = []
    for j in range(nv + 1):
        v = j / nv
        y = y_belt + (y_brow - y_belt) * (1.0 - (1.0 - v) ** 1.08)
        hw = width
        if y > y_brow - r_top:
            d = y - (y_brow - r_top)
            hw = (width - r_top) + math.sqrt(max(0.0, r_top * r_top - d * d))
        # Sit on the body skin and push outward along the front.
        s_skin = _nose_skin_s(y)
        row = []
        for i in range(nu + 1):
            us = (i / nu) * 2.0 - 1.0
            x = us * hw
            y_i = y + (1.0 - v) * 0.03 * (1.0 - us * us)
            wrap = -(x * x) / (2.0 * r_plan)
            z = z_joint + front * (s_skin * NOSE_LEN + wrap)
            nx = us * 0.55
            nz = float(front)
            nlen = math.hypot(nx, nz) or 1.0
            row.append((x + offset * nx / nlen, y_i, z + offset * nz / nlen))
        rows.append(row)
    return rows


def _grid_to_bmesh(rows, close_solid: bool = False, inward_rows=None) -> bmesh.types.BMesh:
    bm = bmesh.new()
    nv = len(rows)
    nu = len(rows[0])
    verts = []
    for row in rows:
        verts.append([bm.verts.new(to_b(*p)) for p in row])
    bm.verts.ensure_lookup_table()
    for j in range(nv - 1):
        for i in range(nu - 1):
            try:
                bm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
            except ValueError:
                continue
    if close_solid and inward_rows is not None:
        iverts = []
        for row in inward_rows:
            iverts.append([bm.verts.new(to_b(*p)) for p in row])
        bm.verts.ensure_lookup_table()
        for j in range(nv - 1):
            for i in range(nu - 1):
                try:
                    bm.faces.new((iverts[j][i + 1], iverts[j][i],
                                  iverts[j + 1][i], iverts[j + 1][i + 1]))
                except ValueError:
                    continue
        # Stitch sides, top, bottom
        for i in range(nu - 1):
            try:
                bm.faces.new((verts[0][i + 1], verts[0][i], iverts[0][i], iverts[0][i + 1]))
            except ValueError:
                pass
            try:
                bm.faces.new((verts[nv - 1][i], verts[nv - 1][i + 1],
                              iverts[nv - 1][i + 1], iverts[nv - 1][i]))
            except ValueError:
                pass
        for j in range(nv - 1):
            try:
                bm.faces.new((verts[j][0], verts[j + 1][0], iverts[j + 1][0], iverts[j][0]))
            except ValueError:
                pass
            try:
                bm.faces.new((verts[j + 1][nu - 1], verts[j][nu - 1],
                              iverts[j][nu - 1], iverts[j + 1][nu - 1]))
            except ValueError:
                pass
    return bm



def _add_wipers(parent, front, z_joint, mats) -> None:
    """Two windscreen wipers parked on the lower glass; direct children of the cab."""
    y = 1.22
    z0 = z_joint + front * (_nose_skin_s(y) * NOSE_LEN - 0.04)
    for sx, inward in ((-0.40, 1.0), (0.40, -1.0)):
        arm = add_box("wiper-arm", 0.016, 0.72, 0.016,
                      sx, y + 0.34, z0 - front * 0.10,
                      mats["trim"], parent)
        arm.rotation_euler = _rot_x_as_blender(-0.36 if front > 0 else 0.36)
        add_box("wiper-blade", 0.012, 0.58, 0.018,
                sx + inward * 0.06, y + 0.68, z0 - front * 0.16,
                mats["rubber"], parent)


def _add_camera_arms(parent, front, z_joint, mats) -> None:
    """Side camera / mirror stalks just behind the A-pillar, both sides."""
    for sx in (-1.0, 1.0):
        x0 = sx * (HALF_W - 0.02)
        y0 = 1.95
        z0 = z_joint + front * 0.04
        # Stalk stubs out, slightly forward and down like the real pod.
        add_cyl("cam-stump", 0.028, 0.08, x0, y0, z0, "x", mats["trim"], parent, segs=10)
        x1 = sx * (HALF_W + 0.13)
        add_cyl("cam-arm", 0.016, 0.16, (x0 + x1) / 2.0, y0 - 0.02, z0 + front * 0.04,
                "x", mats["trim"], parent, segs=8)
        add_rounded_box("cam-pod", 0.07, 0.08, 0.11,
                        x1, y0 - 0.04, z0 + front * 0.06,
                        mats["trim"], parent, radius=0.015, seg=2)

def _add_chin_valance(parent, front, half, z_joint, mats, suffix: str) -> None:
    """Black lower-chin mask with circular lamps, chrome strip, and chin number."""
    # A shallow wraparound band between the white bumper and the glass belt.
    y0, y1 = 0.72, 1.18
    nu, nv = 20, 5
    W = HALF_W * 0.72
    r_plan = 1.55
    rows = []
    for j in range(nv + 1):
        v = j / nv
        y = y0 + (y1 - y0) * v
        s = min(0.98, _nose_skin_s(y) + 0.012)
        row = []
        for i in range(nu + 1):
            us = (i / nu) * 2.0 - 1.0
            x = us * W
            wrap = -(x * x) / (2.0 * r_plan)
            z = z_joint + front * (s * NOSE_LEN + wrap + 0.02)
            row.append((x, y, z))
        rows.append(row)
    # Slightly thicker solid
    inward = []
    for j, row in enumerate(rows):
        inward.append([(x, y, z - front * 0.08) for (x, y, z) in row])
    bm = _grid_to_bmesh(rows, close_solid=True, inward_rows=inward)
    mesh = mesh_from_bm("chin-valance", bm)
    bm.free()
    new_obj("chin-valance", mesh, mats["valance"], parent)

    # Horizontal chrome trim across the valance
    add_cyl("chin-trim", 0.012, 1.55, 0.0, 0.88, z_joint + front * (min(0.98, _nose_skin_s(0.88) + 0.02) * NOSE_LEN),
            "x", mats["chrome"], parent, segs=10)

    # Circular lamp housings in the valance (real Freedom: low, wide, in the black mask).
    y_lamp = 0.92
    z_lamp = z_joint + front * (min(0.98, _nose_skin_s(0.92) + 0.025) * NOSE_LEN)
    x_lamp = 0.70
    for sx, tag in ((-1, "L"), (1, "R")):
        aname = f"lampAnchor-head-{tag}" if front > 0 else f"lampAnchor-tail-{tag}"
        new_empty(aname, (sx * x_lamp, y_lamp, z_lamp), parent=parent,
                  rot_z=(math.pi if front < 0 else 0.0))
        add_cyl(f"lamp-ring-{tag}", 0.12, 0.03,
                sx * x_lamp, y_lamp, z_lamp + front * 0.01,
                "z", mats["chrome"], parent, segs=20)
        add_cyl(f"lamp-bucket-{tag}", 0.10, 0.06,
                sx * x_lamp, y_lamp, z_lamp - front * 0.02,
                "z", mats["valance"], parent, segs=16)
        add_cyl(f"lamp-lens-{tag}", 0.085, 0.025,
                sx * x_lamp, y_lamp, z_lamp + front * 0.03,
                "z", mats["lens"], parent, segs=20)

    # Fleet number on the black valance (no manufacturer mark).
    w, h = 512, 160
    px = _new_pixels(w, h, (0.04, 0.04, 0.045))
    text = f"{FLEET_NO}{suffix}"
    # _draw_text treats (u,v) as the left-middle; centre a 4-glyph 5x7 string.
    scale = 12
    tw = (len(text) * 6 - 1) * scale
    u = max(0.02, (w - tw) / 2.0 / w)
    _draw_text(px, w, h, text, u, 0.50, scale, (0.93, 0.93, 0.94))
    img = bpy.data.images.new(f"chin-num-{suffix}", width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(px)
    img.pack()
    num_mat = make_mat(f"chinNum{suffix}", (0.04, 0.04, 0.045), 0.15, 0.45, image=img)
    add_box("chin-number", 0.70, 0.16, 0.01,
            0.0, 0.96, z_joint + front * (min(0.98, _nose_skin_s(0.96) + 0.03) * NOSE_LEN),
            num_mat, parent)



def _freedom_nose_table():
    """Blunt rounded-rect Freedom nose: boxy until mid-nose, then a mildly
    raked front face with a compact brow and chin (not a pointed beak).

    Each row is (s, sx, y_bot, y_roof) with s=0 at the body/nose joint and
    s=1 at the bumper tip.
    """
    r_brow, r_chin, r_plan = 0.42, 0.28, 0.55
    # Glass plane: brow further back than the belt (~18 deg from vertical).
    s_belt, s_brow_front = 0.90, 0.58
    rows = []
    n = 14
    for i in range(n):
        s = i / (n - 1)
        # Plan width: nearly full until the corner radius, then a quarter-circle.
        s_corner = 1.0 - r_plan / NOSE_LEN
        sx_taper = 1.0 - 0.03 * min(1.0, s / max(s_corner, 1e-6))
        if s <= s_corner:
            sx = sx_taper
        else:
            phi = (s - s_corner) / (1.0 - s_corner) * (math.pi / 2.0)
            sx = ((HALF_W * sx_taper - r_plan) + r_plan * math.cos(phi)) / HALF_W
            sx = max(0.58, min(sx_taper, sx))
        # Roof: stay high through the boxy cab, then follow a raked brow.
        # Linear target of the raked plane, then a circular brow cap.
        if s <= s_brow_front:
            yr = Y_ROOF - 0.10 * (s / max(s_brow_front, 1e-6))
        else:
            t = min(1.0, (s - s_brow_front) / max(1e-6, s_belt - s_brow_front))
            y_plane = (Y_ROOF - 0.10) + t * (1.16 - (Y_ROOF - 0.10))
            # Soften the brow with a slight extra drop only near the start.
            yr = y_plane
        # Chin: stay low until the last ~0.28 m, then roll under.
        s_chin0 = 1.0 - r_chin / NOSE_LEN
        if s <= s_chin0:
            yb = Y_BOT
        else:
            phi = (s - s_chin0) / (1.0 - s_chin0) * (math.pi / 2.0)
            yb = (Y_BOT + r_chin) - r_chin * math.cos(phi)
        # Keep a usable front-face height (never collapse to a point).
        yr = max(yr, yb + 0.45)
        rows.append((round(s, 4), round(sx, 4), round(yb, 4), round(yr, 4)))
    return rows


def _nose_skin_s(y: float) -> float:
    """Forward parameter s of the nose roof/front silhouette at height y."""
    rows = _freedom_nose_table()
    if y >= rows[0][3]:
        return rows[0][0]
    for i, (s, _sx, yb, yr) in enumerate(rows):
        if yr <= y:
            if i == 0:
                return s
            s0, _, _, yr0 = rows[i - 1]
            t = (yr0 - y) / max(1e-6, yr0 - yr)
            return s0 + t * (s - s0)
    return rows[-1][0]


def cab_nose_stations(front: int, half_len: float, nose_len: float, u_at):
    """Blunt, rounded Freedom nose, matched to the 514 / 504B / 501B photos."""
    z_joint = front * (half_len - nose_len)
    base = body_profile()
    rings = []
    for s, sx, yb, yr in _freedom_nose_table():
        z = z_joint + front * s * nose_len
        rings.append({"pts": scale_profile(base, sx, yb, yr), "z": z, "u": u_at(z)})
    return rings, z_joint


def _body_half_at(y: float) -> float:
    """Half-width of the mid-body profile at height y (matches the loft seam)."""
    x_bot = HALF_W
    x_top = max(0.2, HALF_W - TUMBLE)
    y_side0 = Y_BOT + R_BOTTOM
    y_side1 = Y_ROOF - R_SHOULDER
    if y <= y_side0:
        return x_bot
    # Flat roof half-width (matches body_profile's top point at x_top - R_SHOULDER).
    # Do not pinch to a spike — that was the v5a/v5b "broken hat".
    if y >= Y_ROOF:
        return max(0.2, x_top - R_SHOULDER)
    if y >= y_side1:
        cy = Y_ROOF - R_SHOULDER
        cx = x_top - R_SHOULDER
        dy = min(R_SHOULDER, max(0.0, y - cy))
        ca = math.sqrt(max(0.0, 1.0 - (dy / R_SHOULDER) ** 2))
        return cx + R_SHOULDER * ca
    t = (y - y_side0) / max(1e-6, y_side1 - y_side0)
    return x_bot + (x_top - x_bot) * t


def _tumble_t(y: float) -> float:
    """0 at the belt and below, 1 at the roof — smoothstep."""
    if y <= Y_BELT:
        return 0.0
    t = (y - Y_BELT) / max(1e-6, Y_ROOF - Y_BELT)
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def _front_radius(y: float) -> float:
    """Corner radius grows toward the roof so the top reads as a soft curve."""
    return R_FRONT + 0.20 * _tumble_t(y)


def _front_plan_path(front: float, z_tip: float, y: float = Y_BELT,
                     n_corner: int = 14, n_front: int = 12):
    """Plan path from the left A-pillar around the front to the right at height y.

    Each item is (x, z, nx, nz) in Three.js, with *outward* horizontal normals.
    The front straight is a shallow bow (plan convex). Width follows the body
    profile at this height; extra tumblehome is applied later on frontal points.
    """
    hw = max(0.35, _body_half_at(y))
    r = min(_front_radius(y), hw - 0.10)
    bow = FRONT_BOW
    z_c = z_tip - front * r
    cx_l, cx_r = -(hw - r), (hw - r)
    pts: list[tuple[float, float, float, float]] = []

    def add(x, z, nx, nz):
        nlen = math.hypot(nx, nz) or 1.0
        pts.append((x, z, nx / nlen, nz / nlen))

    def outward(tx, tz):
        nx, nz = -tz, tx
        if nz * front < 0:
            nx, nz = -nx, -nz
        return nx, nz

    add(-hw, z_c - front * 0.05, -1.0, 0.0)
    add(-hw, z_c, -1.0, 0.0)
    for i in range(1, n_corner + 1):
        th = math.pi + (math.pi / 2 - math.pi) * (i / n_corner)
        nx, nz = math.cos(th), front * math.sin(th)
        add(cx_l + r * nx, z_c + r * nz, nx, nz)
    span = cx_r - cx_l
    for i in range(1, n_front + 1):
        u = i / n_front
        x = cx_l + span * u
        sag = 4.0 * u * (1.0 - u)
        z = z_tip + front * bow * sag
        nx, nz = outward(span, front * bow * 4.0 * (1.0 - 2.0 * u))
        add(x, z, nx, nz)
    for i in range(1, n_corner + 1):
        th = math.pi / 2 + (0.0 - math.pi / 2) * (i / n_corner)
        nx, nz = math.cos(th), front * math.sin(th)
        add(cx_r + r * nx, z_c + r * nz, nx, nz)
    add(hw, z_c - front * 0.05, 1.0, 0.0)
    return pts


def _front_point(x, z, nx, nz, y, front, outward=0.0):
    """A point on the raked, tumbled, wraparound cab front at height y."""
    frontness = max(0.0, min(1.0, abs(nz)))
    sc = 1.0 - FRONT_TUMBLE * _tumble_t(y) * (frontness ** 0.65)
    x = x * sc
    yy = y
    if y >= Y_BELT:
        # Face rakes back; sides stay on the A-pillar seam so the roof
        # corners don't pull off the body and show the cab interior.
        back = FRONT_RAKE * (y - Y_BELT) * (frontness ** 0.85)
    else:
        t = max(0.0, (Y_SKIRT + 0.12 - y) / 0.28)
        back = 0.10 * t * t
    return (x + nx * outward, yy, z + nz * outward - front * back)


def _front_y_samples() -> list[float]:
    ys = []
    for i in range(10):
        ys.append(Y_BOT + (Y_BELT - Y_BOT) * (i / 9))
    # denser through the lamp panel and glass
    for i in range(1, 16):
        ys.append(Y_BELT + (Y_FRONT_GLASS_TOP - Y_BELT) * (i / 15))
    # Blue roof-edge band up to the roof
    for i in range(1, 6):
        ys.append(Y_FRONT_GLASS_TOP + (Y_ROOF - Y_FRONT_GLASS_TOP) * (i / 5))
    return ys


def _path_s(path) -> list[float]:
    s = [0.0]
    for i in range(1, len(path)):
        x0, z0, _, _ = path[i - 1]
        x1, z1, _, _ = path[i]
        s.append(s[-1] + math.hypot(x1 - x0, z1 - z0))
    return s


def _build_cab_front(parent, front, half, mats, suffix: str) -> None:
    """Separate raked wraparound cab front, with a real windscreen opening.

    Nearly vertical, slightly raked, with tumblehome and a bowed plan. The
    windscreen meets a flush faired blue C-band that grows out of the roof
    edge and runs down the A-pillars to the chin. A black lamp/number panel
    sits under the glass.
    """
    z_tip = front * half
    z_c = z_tip - front * R_FRONT
    path0 = _front_plan_path(front, z_tip, y=Y_BELT)
    ys = _front_y_samples()
    slen = _path_s(path0)
    total = slen[-1] or 1.0
    pillar_w = BLUE_BAND * 0.95

    def is_pillar(i: int) -> bool:
        return slen[i] < pillar_w or (total - slen[i]) < pillar_w

    def is_glass_y(y: float) -> bool:
        return (Y_BELT + 0.01) <= y <= (Y_FRONT_GLASS_TOP - 0.01)

    def is_valance_y(y: float) -> bool:
        return y <= 0.52

    def is_panel_y(y: float) -> bool:
        return Y_PANEL_BOT - 0.01 <= y <= Y_PANEL_TOP + 0.01

    def is_blue(i: int, y: float) -> bool:
        # Top of the C: the roof-edge strip, meeting the glass — no white brow.
        # Skip the short side-overlap stubs so they cannot flare as roof horns.
        if y >= Y_FRONT_GLASS_TOP - 0.02:
            # Full roof-edge strip, including the short side stubs, so the
            # blue meets the body roof with no white brow or corner gap.
            return True
        if y < 0.62:
            return False
        # Legs taper slightly toward the chin.
        w = BLUE_BAND
        if y < Y_BELT:
            w = BLUE_BAND * max(0.50, (y - 0.62) / max(0.1, Y_BELT - 0.62))
        return slen[i] < w or (total - slen[i]) < w

    def ring_at(y, outward):
        path = _front_plan_path(front, z_tip, y=y)
        row = []
        for (x, z, nx, nz) in path:
            row.append(_front_point(x, z, nx, nz, y, front, outward))
        return row

    def build_layer(outward, y_pred, path_pred, close=False):
        used_j = [j for j, y in enumerate(ys) if y_pred(y)]
        if len(used_j) < 2:
            return None
        # Use the belt path's path_pred; rows still have the same point count.
        used_i = [i for i in range(len(path0)) if path_pred(i)]
        if len(used_i) < 2:
            return None
        rows_out, rows_in = [], []
        for j in used_j:
            ro, ri = [], []
            path = _front_plan_path(front, z_tip, y=ys[j])
            for i in used_i:
                x, z, nx, nz = path[i]
                ro.append(_front_point(x, z, nx, nz, ys[j], front, outward))
                ri.append(_front_point(x, z, nx, nz, ys[j], front, outward - 0.07))
            rows_out.append(ro)
            rows_in.append(ri)
        return _grid_to_bmesh(rows_out, close_solid=close, inward_rows=rows_in if close else None)

    # ---- body shell with a windscreen opening ----
    full_out, full_in = [], []
    for y in ys:
        full_out.append(ring_at(y, 0.0))
        full_in.append(ring_at(y, -0.07))
    bm = bmesh.new()

    def grid_verts(rows):
        return [[bm.verts.new(to_b(*p)) for p in row] for row in rows]

    vo, vi = grid_verts(full_out), grid_verts(full_in)
    bm.verts.ensure_lookup_table()
    nj, ni = len(ys), len(path0)

    def add_quad(a, b, c, d):
        try:
            bm.faces.new((a, b, c, d))
        except ValueError:
            pass

    for j in range(nj - 1):
        y0, y1 = ys[j], ys[j + 1]
        ymid = 0.5 * (y0 + y1)
        glass_strip = is_glass_y(ymid)
        for i in range(ni - 1):
            if glass_strip and not (is_pillar(i) or is_pillar(i + 1)):
                continue
            # Leave the outer skin off where the flush C-band covers, so the
            # white shell cannot peek as slivers at the brow or A-pillar.
            if not (is_blue(i, ymid) or is_blue(i + 1, ymid)):
                add_quad(vo[j][i], vo[j][i + 1], vo[j + 1][i + 1], vo[j + 1][i])
            add_quad(vi[j][i + 1], vi[j][i], vi[j + 1][i], vi[j + 1][i + 1])
    for i in range(ni - 1):
        add_quad(vo[0][i + 1], vo[0][i], vi[0][i], vi[0][i + 1])
        add_quad(vo[nj - 1][i], vo[nj - 1][i + 1], vi[nj - 1][i + 1], vi[nj - 1][i])
    for j in range(nj - 1):
        add_quad(vo[j][0], vo[j + 1][0], vi[j + 1][0], vi[j][0])
        add_quad(vo[j + 1][ni - 1], vo[j][ni - 1], vi[j][ni - 1], vi[j + 1][ni - 1])
    for j in range(nj - 1):
        if not is_glass_y(0.5 * (ys[j] + ys[j + 1])):
            continue
        for i in range(ni - 1):
            if is_pillar(i) and not is_pillar(i + 1):
                add_quad(vo[j][i], vi[j][i], vi[j + 1][i], vo[j + 1][i])
            if is_pillar(i + 1) and not is_pillar(i):
                add_quad(vo[j][i + 1], vo[j + 1][i + 1], vi[j + 1][i + 1], vi[j][i + 1])
    for i in range(ni - 1):
        if is_pillar(i) and is_pillar(i + 1):
            continue
        for j in range(nj - 1):
            below = (not is_glass_y(ys[j])) and is_glass_y(ys[j + 1])
            above = is_glass_y(ys[j]) and (not is_glass_y(ys[j + 1]))
            if below:
                add_quad(vo[j + 1][i], vo[j + 1][i + 1], vi[j + 1][i + 1], vi[j + 1][i])
            # No white lintel at the top of the glass — the blue C meets it.

    shell = mesh_from_bm("cab-front-shell", bm)
    bm.free()
    obj = new_obj("cab-front", shell, mats["chin"], parent)
    polish_shell(obj, bevel_width=0.004, bevel_seg=1)

    # Flush faired blue C-band — painted on the surface, not a proud ribbon.
    # Slight outward offset only to avoid z-fighting with the white shell.
    band_rows = []
    band_i = list(range(len(path0)))
    band_y = [y for y in ys if any(is_blue(i, y) for i in band_i)]
    if len(band_y) >= 2:
        # Build a grid, dropping cells that are not in the C so the legs
        # don't fill the windscreen.
        # Easier: emit a strip-per-row only where is_blue, as several patches.
        # One mesh: include a point if is_blue, skip faces otherwise.
        bbm = bmesh.new()
        brows = []
        for y in band_y:
            path = _front_plan_path(front, z_tip, y=y)
            brows.append([bbm.verts.new(to_b(*_front_point(*path[i][:2], path[i][2], path[i][3], y, front, 0.006)))
                          for i in range(len(path0))])
        bbm.verts.ensure_lookup_table()
        for j in range(len(band_y) - 1):
            ymid = 0.5 * (band_y[j] + band_y[j + 1])
            for i in range(len(path0) - 1):
                if not (is_blue(i, ymid) or is_blue(i + 1, ymid)):
                    continue
                try:
                    bbm.faces.new((brows[j][i], brows[j][i + 1],
                                   brows[j + 1][i + 1], brows[j + 1][i]))
                except ValueError:
                    pass
        if bbm.faces:
            new_obj("cab-band", mesh_from_bm("cab-blue-band", bbm), mats["swoosh"], parent)
        bbm.free()

    # Black lower valance
    vbm = build_layer(0.012, is_valance_y, lambda i: True, close=True)
    if vbm is not None and vbm.faces:
        new_obj("cab-valance", mesh_from_bm("cab-valance", vbm), mats["valance"], parent)
    if vbm is not None:
        vbm.free()

    # Black lamp / number panel under the glass, wraparound.
    pbm = build_layer(0.010, is_panel_y, lambda i: True, close=True)
    if pbm is not None and pbm.faces:
        new_obj("cab-lamp-panel", mesh_from_bm("cab-lamp-panel", pbm), mats["valance"], parent)
    if pbm is not None:
        pbm.free()

    # Windscreen glass: wraparound opening, slightly outboard, dark.
    g_i = [i for i in range(len(path0)) if not is_pillar(i)]
    g_y = [y for y in ys if is_glass_y(y)]
    if len(g_i) >= 2 and len(g_y) >= 2:
        i0 = max(0, g_i[0] - 1)
        i1 = min(len(path0) - 1, g_i[-1] + 1)
        g_rows = []
        for y in g_y:
            path = _front_plan_path(front, z_tip, y=y)
            row = [_front_point(*path[i][:2], path[i][2], path[i][3], y, front, 0.025)
                   for i in range(i0, i1 + 1)]
            g_rows.append(row)
        gbm = _grid_to_bmesh(g_rows, close_solid=False)
        new_obj("windscreen", mesh_from_bm("windscreen-glass", gbm), mats["glassFront"], parent)
        gbm.free()

    mid = min(path0, key=lambda p: abs(p[0]))
    dx, dz, dnx, dnz = mid

    # Dest sign sits in the upper windscreen, slightly behind the glass.
    y_dest = Y_FRONT_GLASS_TOP - 0.20
    px, py, pz = _front_point(dx, dz, dnx, dnz, y_dest, front, -0.02)
    dest = add_box(f"destSign-{'A' if front > 0 else 'E'}", 1.10, 0.16, 0.04,
                   0.0, py, pz, mats["dest"], parent)
    dest.name = f"destSign-{'A' if front > 0 else 'E'}"
    dest.rotation_euler = _rot_x_as_blender(-math.atan(FRONT_RAKE) * front)

    # Headlight clusters + red tails on the black panel, tight grouping.
    y_lamp = 0.96
    x_lamp = 0.70
    path_lamp = _front_plan_path(front, z_tip, y=y_lamp)
    for sx, tag in ((-1.0, "L"), (1.0, "R")):
        hit = min(path_lamp, key=lambda p: abs(p[0] - sx * x_lamp))
        hx, hz, hnx, hnz = hit
        lx, ly, lz = _front_point(hx, hz, hnx, hnz, y_lamp, front, 0.055)
        aname = f"lampAnchor-head-{tag}" if front > 0 else f"lampAnchor-tail-{tag}"
        new_empty(aname, (lx, ly, lz), parent=parent,
                  rot_z=(math.pi if front < 0 else 0.0))
        add_cyl(f"lamp-ring-{tag}", 0.10, 0.03, lx, ly, lz, "z", mats["chrome"], parent, segs=20)
        add_cyl(f"lamp-lens-{tag}", 0.078, 0.025,
                lx, ly, lz + front * 0.02, "z", mats["lens"], parent, segs=20)
        rx = lx - sx * 0.15
        add_cyl(f"tail-ring-{tag}", 0.055, 0.025, rx, ly, lz, "z", mats["chrome"], parent, segs=16)
        add_cyl(f"tail-lens-{tag}", 0.042, 0.02,
                rx, ly, lz + front * 0.02, "z", mats["tailLens"], parent, segs=16)

    # Fleet number, white on the black panel, UV-mapped so it actually reads.
    y_num = 1.14
    nx_, ny_, nz_ = _front_point(dx, dz, dnx, dnz, y_num, front, 0.04)
    tw, th = 1024, 320
    pix = _new_pixels(tw, th, (0.04, 0.04, 0.045))
    text = f"{FLEET_NO}{suffix}"
    scale = 36
    glyph_w = (len(text) * 6 - 1) * scale
    u = max(0.02, (tw - glyph_w) / 2.0 / tw)
    _draw_text(pix, tw, th, text, u, 0.50, scale, (0.93, 0.93, 0.94))
    img = bpy.data.images.new(f"chin-num-{suffix}", width=tw, height=th, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(pix)
    img.pack()
    num_mat = make_mat(f"chinNum{suffix}", (0.04, 0.04, 0.045), 0.15, 0.35, image=img)
    plate = add_front_plate("chin-number", 0.95, 0.22, 0.0, 0.0, 0.0, 1.0, num_mat, parent)
    plate.location = Vector(to_b(0.0, ny_, nz_))
    # Built facing Three.js +Z; cab E needs a 180° yaw (Blender +Z = Three.js +Y).
    plate.rotation_euler = (
        -math.atan(FRONT_RAKE) * front,
        0.0,
        math.pi if front < 0 else 0.0,
    )

    # Wipers parked on the lower glass, just above the belt.
    y_w = Y_BELT + 0.10
    path_w = _front_plan_path(front, z_tip, y=y_w)
    for sx, inward in ((-0.42, 1.0), (0.42, -1.0)):
        hit = min(path_w, key=lambda p: abs(p[0] - sx))
        wx, wz, wnx, wnz = hit
        px, py, pz = _front_point(wx, wz, wnx, wnz, y_w, front, 0.03)
        arm = add_box("wiper-arm", 0.016, 0.80, 0.016,
                      px, py + 0.38, pz - front * 0.10, mats["trim"], parent)
        arm.rotation_euler = _rot_x_as_blender(-math.atan(FRONT_RAKE) * front)
        add_box("wiper-blade", 0.012, 0.58, 0.018,
                px + inward * 0.06, py + 0.72, pz - front * 0.16, mats["rubber"], parent)

    # Side cameras just behind the A-pillar.
    for sx in (-1.0, 1.0):
        x0 = sx * (HALF_W - 0.02)
        y0 = 2.05
        z0 = z_c - front * 0.12
        add_cyl("cam-stump", 0.028, 0.08, x0, y0, z0, "x", mats["trim"], parent, segs=10)
        x1 = sx * (HALF_W + 0.13)
        add_cyl("cam-arm", 0.016, 0.16, (x0 + x1) / 2.0, y0 - 0.02, z0 + front * 0.03,
                "x", mats["trim"], parent, segs=8)
        add_rounded_box("cam-pod", 0.07, 0.08, 0.11,
                        x1, y0 - 0.04, z0 + front * 0.05,
                        mats["trim"], parent, radius=0.015, seg=2)

    # Solid front-roof lid. The shell is only a 7 cm rim, so without this
    # fill a head-on view looks into a black hole behind the lip. A chord
    # grid (not a triangle fan) keeps the bowed surface smooth, no centre crease.
    roof_path = _front_plan_path(front, z_tip, y=Y_ROOF)
    p0 = _front_point(*roof_path[0][:2], roof_path[0][2], roof_path[0][3], Y_ROOF, front, 0.0)
    pN = _front_point(*roof_path[-1][:2], roof_path[-1][2], roof_path[-1][3], Y_ROOF, front, 0.0)
    front_pts = [_front_point(*rp[:2], rp[2], rp[3], Y_ROOF, front, 0.0) for rp in roof_path]
    n_span = 6
    rbm = bmesh.new()
    rows = []
    dx = pN[0] - p0[0]
    for s in range(n_span + 1):
        t = s / n_span
        row = []
        for px, py, pz in front_pts:
            u = 0.0 if abs(dx) < 1e-6 else (px - p0[0]) / dx
            zb = p0[2] + (pN[2] - p0[2]) * u
            xb = p0[0] + (pN[0] - p0[0]) * u
            ix = xb * (1.0 - t) + px * t
            iz = zb * (1.0 - t) + pz * t
            iy = py + 0.008
            row.append(rbm.verts.new(to_b(ix, iy, iz)))
        rows.append(row)
    for j in range(n_span):
        for i in range(len(front_pts) - 1):
            try:
                # Winding (j,i), (j,i+1), (j+1,i+1), (j+1,i) — top face +Y
                rbm.faces.new((rows[j][i], rows[j][i + 1],
                               rows[j + 1][i + 1], rows[j + 1][i]))
            except ValueError:
                pass
    if rbm.faces:
        new_obj("cab-roof-lid", mesh_from_bm("cab-roof-lid", rbm), mats["swoosh"], parent)
    rbm.free()


    # Marker on the front of the blue brow, not on the roof silhouette
    # (a cylinder on the roof lip read as a notch in head-on).
    y_mk = Y_ROOF - 0.16
    path_b = _front_plan_path(front, z_tip, y=y_mk)
    bx, bz, bnx, bnz = min(path_b, key=lambda p: abs(p[0]))
    mx, my, mz = _front_point(bx, bz, bnx, bnz, y_mk, front, 0.02)
    add_cyl("brow-marker", 0.018, 0.024, mx, my, mz, "z", mats["lens"], parent, segs=10)


def _add_side_glass(parent, side, z, length, mats) -> None:
    """Explicit tall side-glass panel, slightly outside the skin."""
    if length < 0.25:
        return
    x = side * (HALF_W + 0.012)
    add_box("side-glass", 0.018, Y_WIN_H, length,
            x, Y_WIN_MID, z, mats["glass"], parent)

def _add_roof_cap(parent, z0, z1, mats, front: float = 0.0) -> None:
    """Thin blue roof cap with a defined edge, along this module's body."""
    # On cabs, pull the cap back from the A-pillar so its square end
    # doesn't form ears behind the rounded front roof.
    if front > 0:
        z1 = z1 - 0.30
    elif front < 0:
        z0 = z0 + 0.30
    zmid = 0.5 * (z0 + z1)
    length = max(0.4, abs(z1 - z0) - 0.36)
    add_box("roof-cap", LRV_WIDTH * 0.72, 0.034, length,
            0.0, Y_ROOF + 0.012, zmid, mats["swoosh"], parent)

def build_module(i: int, mats: dict) -> bpy.types.Object:
    spec = MODULES[i]
    name = f"module-{spec['name']}"
    root = new_empty(name, (0, 0, 0))
    length = spec["len"]
    half = length / 2.0
    is_cab = i in (0, len(MODULES) - 1)
    front = 1 if i == 0 else (-1 if i == len(MODULES) - 1 else 0)
    body_mat = mats["cabA"] if i == 0 else mats["cabE"] if i == len(MODULES) - 1 else mats["mid"]

    def u_at(z: float) -> float:
        if front == -1:
            return (half - z) / length
        return (z - (-half)) / length

    z_rear, z_front = -half, half
    # Cab body stops at the A-pillar plane. The wraparound front is a
    # separate swept mesh (_build_cab_front), not a loft carve.
    if front != 0:
        z_ap = front * (half - R_FRONT)
        body_z0 = z_ap if front == -1 else z_rear
        body_z1 = z_ap if front == 1 else z_front
    else:
        body_z0, body_z1 = z_rear, z_front

    base = body_profile()
    rings: list[dict] = []
    if front == 0:
        nseg = 16 if i != 2 else 10
        for k in range(nseg + 1):
            t = k / nseg
            z = z_rear + (z_front - z_rear) * t
            rings.append({"pts": base, "z": z, "u": u_at(z)})
        cap_start = cap_end = True
    else:
        nseg = 14
        for k in range(nseg + 1):
            t = k / nseg
            z = body_z0 + (body_z1 - body_z0) * t
            rings.append({"pts": base, "z": z, "u": u_at(z)})
        # Leave the A-pillar end open so the windscreen looks into the cab.
        cap_start = front == 1   # cap the rear articulation
        cap_end = front == -1

    bm = loft_shell(rings, cap_start, cap_end)

    # Recessed door pockets (not on the centre module). Cab doors sit near the
    # rear articulation, with only a short logo panel after them.
    door_z = 0.0 if not is_cab else (-1.65 if i == 0 else 1.65)
    door_half = 0.68
    if i != 2:
        y0, y1 = 0.22, Y_WIN_TOP
        for side in (-1.0, 1.0):
            recess_door_region(bm, side, door_z, door_half, y0, y1, depth=0.10)

    # Tall, almost-continuous side glass from the belt to just under the roof
    # lip, with only narrow body pillars between panes. C is two bays, no door.
    win_h = Y_WIN_H
    win_y = Y_WIN_MID
    panes: list[tuple[float, float]] = []  # (z, len)
    if is_cab:
        z_a = (body_z1 - 0.06) if i == 0 else (body_z0 + 0.06)
        z_door_front = door_z + (door_half if i == 0 else -door_half)
        mid = (z_a + z_door_front) / 2.0
        ln = abs(z_a - z_door_front) - PILLAR
        if ln > 0.4:
            panes.append((mid, ln))
    elif i != 2:
        span = (body_z1 - body_z0) / 2.0 - door_half - PILLAR
        if span > 0.4:
            panes.append((-door_half - PILLAR * 0.5 - span / 2.0, span))
            panes.append((door_half + PILLAR * 0.5 + span / 2.0, span))
    else:
        panes.append((-0.80, 1.48))
        panes.append((0.80, 1.48))

    glass_bms: list[bmesh.types.BMesh] = []

    def in_pane(x, y, z, pz, plen, side_sign):
        if x * side_sign <= 0:
            return False
        if abs(x) < HALF_W - 0.18:
            return False
        if abs(y - win_y) > win_h * 0.48:
            return False
        if abs(z - pz) > plen * 0.48:
            return False
        return True

    for pz, plen in panes:
        for side in (-1.0, 1.0):
            faces = collect_faces(bm, lambda x, y, z, pz=pz, plen=plen, side=side: in_pane(x, y, z, pz, plen, side))
            g = extract_faces_as_glass(bm, faces, bulge=0.0, offset=0.016)
            if g is not None and g.faces:
                glass_bms.append(g)
            elif g is not None:
                g.free()

    body_mesh = mesh_from_bm(f"{name}-body", bm)
    bm.free()
    body_obj = new_obj("body", body_mesh, body_mat, root)
    polish_shell(body_obj, bevel_width=0.012, bevel_seg=2)

    if glass_bms:
        gbm = bmesh.new()
        for src in glass_bms:
            verts_map = {}
            uv_s = src.loops.layers.uv.get("UVMap")
            uv_d = gbm.loops.layers.uv.get("UVMap") or gbm.loops.layers.uv.new("UVMap")
            for v in src.verts:
                verts_map[v] = gbm.verts.new(v.co)
            gbm.verts.ensure_lookup_table()
            for f in src.faces:
                try:
                    nf = gbm.faces.new([verts_map[v] for v in f.verts])
                except ValueError:
                    continue
                if uv_s:
                    for ls, ld in zip(f.loops, nf.loops):
                        ld[uv_d].uv = ls[uv_s].uv.copy()
            src.free()
        glass_mesh = mesh_from_bm(f"{name}-windows", gbm)
        gbm.free()
        new_obj("windows", glass_mesh, mats["glass"], root)

    # Explicit outward glass so the tall window band is visible even if a
    # punch misses a face. The remaining body between panes is the pillar.
    for pz, plen in panes:
        for side in (-1.0, 1.0):
            _add_side_glass(root, side, pz, plen, mats)

    _add_roof_cap(root, body_z0, body_z1, mats, front=front)

    # Roof equipment: long, low, rounded-rectangular grey HVAC — not mushroom caps.
    z_mid = (body_z0 + body_z1) / 2.0 if front != 0 else 0.0
    if i != 2:
        pod_len = min(3.2, max(1.3, (body_z1 - body_z0) * 0.70))
        add_rounded_box("hvac", 1.36, 0.16, pod_len,
                        0.0, Y_ROOF + 0.10, z_mid, mats["fairing"], root, radius=0.08, seg=4)
        add_rounded_box("hvac-aux", 0.85, 0.12, max(0.7, pod_len * 0.35),
                        0.0, Y_ROOF + 0.08, z_mid - pod_len * 0.42,
                        mats["fairing"], root, radius=0.05, seg=3)
        add_cyl("antenna", 0.012, 0.28, -0.40, Y_ROOF + 0.28, z_mid + pod_len * 0.20,
                "y", mats["trim"], root, segs=8)
    else:
        add_rounded_box("panto-well", LRV_WIDTH * 0.50, 0.10, 1.8,
                        0.0, Y_ROOF + 0.05, 0.0, mats["fairing"], root, radius=0.05, seg=3)
        add_rounded_box("roof-box-c", 0.70, 0.12, 0.80,
                        0.0, Y_ROOF + 0.10, -1.15, mats["fairing"], root, radius=0.05, seg=3)

    if is_cab:
        suffix = "A" if i == 0 else "B"
        _build_cab_front(root, front, half, mats, suffix)
        z_joint = front * (half - R_FRONT)
        _add_cab_interior(root, front, half, z_joint, mats)

    if i != 2:
        for side in (-1, 1):
            _add_door(root, i, side, door_z, mats)

    if i < len(MODULES) - 1:
        _add_bellows(root, -length / 2.0, mats)

    if i == 2:
        _add_pantograph(root, mats)

    add_box("floor-liner", LRV_WIDTH * 0.84, 0.03, max(0.4, (body_z1 - body_z0) - 0.1),
            0.0, LRV_FLOOR + 0.04, (body_z0 + body_z1) / 2.0, mats["interior"], root)
    add_box("ceiling-liner", LRV_WIDTH * 0.70, 0.03, max(0.4, (body_z1 - body_z0) - 0.1),
            0.0, Y_ROOF - 0.18, (body_z0 + body_z1) / 2.0, mats["interior"], root)

    return root




def _collect_windscreen_faces(bm, front, z_joint) -> list:
    """Loft faces that form the wraparound windscreen (front-facing, glass band)."""
    out = []
    for f in bm.faces:
        x, y, z = _face_centroid(f)
        if y < 1.10 or y > Y_ROOF - 0.05:
            continue
        s = ((z - z_joint) * front) / max(1e-6, NOSE_LEN)
        if s < 0.28:
            continue
        # Blender normal (X, Y_fwd, Z_up) → Three (X, Y_up, Z_fwd)
        nx, ny, nz = f.normal.x, f.normal.z, f.normal.y
        if nz * front < 0.40:
            continue
        if abs(nx) > abs(nz) * 1.35:
            continue
        out.append(f)
    return out


def _is_windscreen_face(x, y, z, front, z_joint) -> bool:
    """True for loft faces that belong to the wraparound Freedom windscreen."""
    if y < 1.14 or y > Y_ROOF - 0.08:
        return False
    s = ((z - z_joint) * front) / max(1e-6, NOSE_LEN)
    if s < 0.42:
        return False
    w = HALF_W - 0.10
    r_top = 0.42
    y_brow = Y_ROOF - 0.12
    if y > y_brow - r_top:
        d = y - (y_brow - r_top)
        w = (w - r_top) + math.sqrt(max(0.0, r_top * r_top - d * d))
    if abs(x) > w - 0.04:
        return False
    return True




def _add_windscreen_glass(front, half, parent, mats) -> None:
    """Raked wraparound glass that sits *in front of* the lofted nose.

    A Z-loft has no vertical front wall — the 'front' you see is the tapered
    roof and cheeks. The glass is therefore an overlay, almost opaque like the
    real black Freedom mask, so the grey wedge does not show through.
    """
    z_joint = front * (half - NOSE_LEN)
    g_rows = _windscreen_surface(front, z_joint, nu=26, nv=16, offset=0.08)

    gbm = _grid_to_bmesh(g_rows, close_solid=False)
    glass_mesh = mesh_from_bm("windscreen-glass", gbm)
    gbm.free()
    new_obj("windscreen", glass_mesh, mats["glassFront"], parent)

    # White chin overlay below the glass, same raked plane.
    y0, y1 = 0.22, 1.16
    nu, nv = 18, 4
    rows = []
    for j in range(nv + 1):
        v = j / nv
        y = y0 + (y1 - y0) * v
        s = min(0.99, _nose_skin_s(y) + 0.04)
        hw = HALF_W * (0.62 + 0.08 * v)
        row = []
        for i in range(nu + 1):
            us = (i / nu) * 2.0 - 1.0
            x = us * hw
            wrap = -(x * x) / (2.0 * 1.55)
            z = z_joint + front * (s * NOSE_LEN + wrap + 0.04)
            row.append((x, y, z))
        rows.append(row)
    cbm = _grid_to_bmesh(rows, close_solid=False)
    chin_mesh = mesh_from_bm("chin-panel", cbm)
    cbm.free()
    new_obj("chin-panel", chin_mesh, mats["chin"], parent)


def _add_door(parent, i, side, door_z, mats) -> None:
    tag = "L" if side < 0 else "R"
    cab = {0: "A", 1: "B", 3: "D", 4: "E"}.get(i, "M")
    x = side * (LRV_WIDTH / 2 - 0.03)
    y0 = 0.24
    y1 = Y_WIN_TOP
    y = 0.5 * (y0 + y1)
    h = y1 - y0
    group = new_empty(f"door-{cab}-{tag}", (x, y, door_z), parent)
    group.location = Vector(to_b(x, y, door_z))
    # Full-height glazed plug door, flush with the side glass.
    add_box("door-panel", 0.04, h, 1.32, 0, 0, 0, mats["door"], group)
    # Two tall panes from a short kick panel up to the roof lip, central mullion.
    kick = 0.28
    gh = h - kick - 0.06
    gy = (kick - 0.02) / 2.0  # shift up from the group centre
    gd = 0.56
    gap = 0.07
    add_box("door-glass-a", 0.022, gh, gd, side * 0.025, gy, -(gd + gap) / 2, mats["glass"], group)
    add_box("door-glass-b", 0.022, gh, gd, side * 0.025, gy, +(gd + gap) / 2, mats["glass"], group)
    add_box("door-mullion", 0.024, gh + 0.02, 0.05, side * 0.025, gy, 0, mats["trim"], group)
    group["side"] = int(side)
    group["baseX"] = float(x)
    group["baseZ"] = float(door_z)

def _add_bellows(parent, bel_z, mats) -> None:
    bel_h = (Y_ROOF - Y_BOT) * 0.985
    bel_y = Y_BOT + 0.01 + bel_h / 2.0
    n_folds = 10
    span = 0.52
    for r in range(n_folds):
        t = r / (n_folds - 1)
        z = bel_z - span / 2.0 + t * span
        fat = 1.0 if r % 2 == 0 else 0.86
        add_rounded_box(f"bellows-{r}", LRV_WIDTH * 0.88 * fat, bel_h, 0.048,
                        0.0, bel_y, z, mats["rubber"], parent, radius=0.02, seg=1)
    add_box("bellows-roof-joint", LRV_WIDTH * 0.84, 0.05, 0.14,
            0.0, Y_ROOF - 0.01, bel_z, mats["trim"], parent)

def _add_pantograph(parent, mats) -> None:
    pan = new_empty("pantograph", (0, 0, 0), parent)
    # Roof base plate + well already present; add insulators and the arm
    add_rounded_box("panto-base", 0.42, 0.08, 0.85,
                    0.0, LRV_HEIGHT + 0.04, 0.0, mats["trim"], pan, radius=0.02, seg=2)
    for sx in (-0.12, 0.12):
        add_cyl("insulator", 0.04, 0.16, sx, LRV_HEIGHT + 0.16, 0.10,
                "y", mats["insulator"], pan, segs=10)
    # Lower arm (base → knee)
    low = add_box("panto-lower", 0.055, 0.055, 1.20,
                  0.0, LRV_HEIGHT + 0.55, 0.18, mats["trim"], pan)
    low.rotation_euler = (_rot_x_as_blender(0.52))
    # Knee
    add_cyl("panto-knee", 0.04, 0.08, 0.0, LRV_HEIGHT + 0.95, 0.42,
            "x", mats["trim"], pan, segs=10)
    # Upper arm (knee → head)
    up = add_box("panto-upper", 0.045, 0.045, 1.15,
                 0.0, LRV_HEIGHT + 1.35, 0.05, mats["trim"], pan)
    up.rotation_euler = (_rot_x_as_blender(-0.62))
    # Pan head + horns
    add_rounded_box("panto-head", 1.55, 0.04, 0.22,
                    0.0, OCS_WIRE_STREET - 0.06, 0.0, mats["trim"], pan, radius=0.015, seg=2)
    for sx in (-0.74, 0.74):
        add_cyl("horn", 0.012, 0.16, sx, OCS_WIRE_STREET - 0.02, 0.0,
                "y", mats["trim"], pan, segs=8)
    shoe = add_box("pantoShoe", 1.60, 0.05, 0.16,
                   0.0, OCS_WIRE_STREET, 0.0, mats["trim"], pan)
    shoe.name = "pantoShoe"


def _rot_x_as_blender(three_rx: float) -> tuple[float, float, float]:
    """A rotation around Three.js +X is a rotation around Blender +X (same axis)."""
    return (three_rx, 0.0, 0.0)



def _add_swoosh(parent, front, half, z_joint, mats) -> None:
    """Blue A-pillar ribbon that follows the lower windscreen edge, as in the photos."""
    for sx in (-1.0, 1.0):
        def zs(y, bump=0.02):
            return z_joint + front * min(0.98, _nose_skin_s(y) + bump) * NOSE_LEN
        pts = [
            # Start on the side, just under the roof lip — not at the roof corner.
            (sx * (HALF_W - 0.07), Y_ROOF - 0.16, z_joint + front * 0.06),
            (sx * (HALF_W - 0.08), 2.85, zs(2.85, 0.00)),
            (sx * (HALF_W - 0.10), 2.20, zs(2.20, 0.00)),
            (sx * (HALF_W - 0.16), 1.55, zs(1.55, 0.01)),
            # Turn along the lower edge of the windscreen, taper toward the centre.
            (sx * (HALF_W * 0.72), 1.22, zs(1.22, 0.02)),
            (sx * (HALF_W * 0.42), 1.17, zs(1.17, 0.02)),
            (sx * 0.22, 1.15, zs(1.15, 0.02)),
        ]
        curve_data = bpy.data.curves.new(f"swoosh-crv-{sx}", "CURVE")
        curve_data.dimensions = "3D"
        curve_data.bevel_depth = 0.032
        curve_data.bevel_resolution = 3
        curve_data.resolution_u = 16
        curve_data.bevel_factor_end = 0.92  # taper the last bit if supported
        try:
            curve_data.taper_object = None
        except Exception:
            pass
        spline = curve_data.splines.new("NURBS")
        spline.points.add(len(pts) - 1)
        for i, (x, y, z) in enumerate(pts):
            bx, by, bz = to_b(x, y, z)
            # Weight the last points down slightly so the ribbon thins toward the chin.
            w = 1.0 if i < len(pts) - 2 else 0.7
            spline.points[i].co = (bx, by, bz, w)
            try:
                spline.points[i].radius = 1.0 if i < 4 else max(0.35, 1.0 - 0.22 * (i - 3))
            except Exception:
                pass
        spline.use_endpoint_u = True
        spline.order_u = min(4, len(pts))
        obj = bpy.data.objects.new(f"swoosh-{sx}", curve_data)
        obj.data.materials.append(mats["swoosh"])
        obj.parent = parent
        bpy.context.collection.objects.link(obj)
        deg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(deg)
        mesh = bpy.data.meshes.new_from_object(ev)
        mesh_obj = bpy.data.objects.new(f"swoosh-{sx}", mesh)
        mesh_obj.data.materials.append(mats["swoosh"])
        mesh_obj.parent = parent
        bpy.context.collection.objects.link(mesh_obj)
        bpy.data.objects.remove(obj, do_unlink=True)
        mesh.shade_smooth()


def _add_cab_interior(parent, front, half, z_joint, mats) -> None:
    # z_joint is the A-pillar plane; the cabin only extends R_FRONT to the tip.
    depth = R_FRONT
    add_box("cab-bulkhead", LRV_WIDTH * 0.90, 2.4, 0.05,
            0.0, LRV_FLOOR + 1.25, z_joint - front * 0.08,
            mats["interior"], parent)
    nose_mid = z_joint + front * (depth * 0.32)
    add_box("cab-floor", LRV_WIDTH * 0.70, 0.04, depth * 0.55,
            0.0, LRV_FLOOR + 0.08, nose_mid, mats["interior"], parent)
    dash = add_box("cab-dash", 1.70, 0.22, 0.28,
                   0.0, 1.05, z_joint + front * (depth * 0.28),
                   mats["dash"], parent)
    dash.rotation_euler = _rot_x_as_blender(-math.atan(FRONT_RAKE) * (1 if front > 0 else -1))
    for sx, tag in ((0.50, "R"), (-0.50, "L")):
        add_rounded_box(f"seat-{tag}", 0.42, 0.70, 0.18,
                        sx, 0.85, z_joint + front * 0.06,
                        mats["seat"], parent, radius=0.04, seg=2)
        add_rounded_box(f"seat-base-{tag}", 0.42, 0.10, 0.36,
                        sx, 0.55, z_joint + front * 0.14,
                        mats["seat"], parent, radius=0.03, seg=2)
    add_cyl("controller", 0.05, 0.35, 0.42, 0.95, z_joint + front * 0.18,
            "y", mats["trim"], parent, segs=8)
    add_box("sun-visor", 1.15, 0.05, 0.12,
            0.0, Y_FRONT_GLASS_TOP - 0.10, z_joint + front * 0.08,
            mats["interior"], parent)


def build_truck(kind: str, mats) -> bpy.types.Object:
    root = new_empty(kind, (0, 0, 0))
    add_rounded_box("truck-frame", 1.70, 0.28, 2.35,
                    0.0, 0.38, 0.0, mats["bogie"], root, radius=0.04, seg=2)
    for sx in (-1.0, 1.0):
        add_box("sideframe", 0.08, 0.38, 2.55, sx * 1.02, 0.36, 0.0, mats["bogie"], root)
        # Low, thin valance — hide the wheels without thickening the skirt.
        add_rounded_box("bogie-skirt", 0.06, 0.16, 2.55,
                        sx * (HALF_W - 0.05), 0.22, 0.0,
                        mats["valance"], root, radius=0.03, seg=2)
    for zz in (-0.925, 0.925):
        for xx in (-0.72, 0.72):
            add_cyl("wheel", 0.33, 0.12, xx, 0.33, zz, "x", mats["bogie"], root, segs=20)
            add_cyl("flange", 0.36, 0.03, xx + (0.07 if xx > 0 else -0.07), 0.33, zz,
                    "x", mats["bogie"], root, segs=20)
    for zz in (-1.22, 1.22):
        add_rounded_box("bogie-apron", 2.40, 0.12, 0.14,
                        0.0, 0.20, zz, mats["valance"], root, radius=0.03, seg=2)
    return root

def count_tris(obj) -> int:
    if obj.type != "MESH" or obj.data is None:
        return 0
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def print_stats(out_path: str) -> None:
    total = 0
    print("=== Flexity mesh stats (Blender space; Y forward, Z up) ===")
    for obj in bpy.data.objects:
        t = count_tris(obj)
        if t:
            total += t
            print(f"  {obj.name:40s}  {t:6d} tris")
    print(f"TOTAL triangles: {total}")
    if os.path.isfile(out_path):
        sz = os.path.getsize(out_path)
        print(f"GLB size: {sz} bytes ({sz / 1048576:.2f} MiB)")
    # Module-local bounds in Three.js space for the A-cab
    cab = bpy.data.objects.get("module-A-cab")
    if cab:
        xs, ys, zs = [], [], []
        for obj in bpy.data.objects:
            if obj.type != "MESH":
                continue
            # walk parents
            p = obj
            under = False
            while p:
                if p == cab:
                    under = True
                    break
                p = p.parent
            if not under:
                continue
            for v in obj.data.vertices:
                # object-local; parents have identity loc except doors etc.
                world = obj.matrix_world @ v.co
                x, y, z = from_b(world)
                xs.append(x)
                ys.append(y)
                zs.append(z)
        if xs:
            print(
                "A-cab Three.js AABB: "
                f"x[{min(xs):.3f},{max(xs):.3f}] "
                f"y[{min(ys):.3f},{max(ys):.3f}] "
                f"z[{min(zs):.3f},{max(zs):.3f}] "
                f"(expect z tip ~ +{MODULES[0]['len']/2:.3f})"
            )




def merge_static_meshes() -> None:
    """Join same-material static meshes under each module / truck / pantograph.

    Hook objects stay separate: destSign, pantoShoe, lamp anchors (empties),
    and everything under a door empty (plug-door animation).
    """
    from collections import defaultdict
    from mathutils import Matrix

    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass

    parents = [o for o in bpy.data.objects
               if o.name.startswith("module-") or o.name.startswith("truck-")
               or o.name == "pantograph"
               or (o.type == "EMPTY" and o.name.startswith("door-"))]
    for parent in parents:
        groups: dict[str, list] = defaultdict(list)
        for obj in list(parent.children):
            if obj.type != "MESH":
                continue
            if obj.name.startswith("destSign") or obj.name == "pantoShoe":
                continue
            mat = obj.data.materials[0].name if obj.data.materials else "_none"
            groups[mat].append(obj)
        for mat, objs in groups.items():
            if len(objs) < 2:
                continue
            target_name = f"{parent.name}-{mat}"
            objs[0].name = target_name
            joined = False
            try:
                with bpy.context.temp_override(
                    object=objs[0],
                    active_object=objs[0],
                    selected_objects=objs,
                    selected_editable_objects=objs,
                ):
                    bpy.ops.object.join()
                joined = True
            except Exception as exc:
                print(f"  join ops failed for {target_name}: {exc}")
            if not joined:
                _manual_join(objs, target_name)


def _manual_join(objs, name: str) -> None:
    """Fallback join: bake local transforms into the first mesh and append the rest."""
    from mathutils import Matrix
    target = objs[0]
    # Bake target local transform into its mesh
    target.data.transform(target.matrix_local)
    target.matrix_local = Matrix.Identity(4)
    bm = bmesh.new()
    bm.from_mesh(target.data)
    src_uv = bm.loops.layers.uv.get("UVMap")
    if src_uv is None:
        src_uv = bm.loops.layers.uv.new("UVMap")
    for o in objs[1:]:
        o.data.transform(o.matrix_local)
        o.matrix_local = Matrix.Identity(4)
        tmp = bmesh.new()
        tmp.from_mesh(o.data)
        # append via bpy mesh: use bmesh.from_mesh after combining with object
        # Easiest reliable path: bmesh.ops + verts copy
        vmap = {}
        uv_s = tmp.loops.layers.uv.get("UVMap")
        for v in tmp.verts:
            vmap[v] = bm.verts.new(v.co)
        bm.verts.ensure_lookup_table()
        for f in tmp.faces:
            try:
                nf = bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            if uv_s is not None:
                for ls, ld in zip(f.loops, nf.loops):
                    ld[src_uv].uv = ls[uv_s].uv.copy()
        tmp.free()
        bpy.data.objects.remove(o, do_unlink=True)
    bm.to_mesh(target.data)
    target.data.update()
    bm.free()
    target.name = name


def export_glb(path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    # Deselect cameras/lights (none) and export the visible scene.
    kw = dict(
        filepath=path,
        export_format="GLB",
        export_image_format="WEBP",
        export_image_quality=88,
        export_jpeg_quality=88,
        export_extras=True,
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_texcoords=True,
        export_normals=True,
    )
    # Drop kwargs the operator might not accept (defensive).
    try:
        rna = bpy.ops.export_scene.gltf.get_rna_type()
        valid = set(rna.properties.keys())
        kw = {k: v for k, v in kw.items() if k in valid or k == "filepath"}
    except Exception:
        pass
    # The addon may not be registered until first access; invoke anyway.
    result = bpy.ops.export_scene.gltf(**kw)
    print("export_scene.gltf →", result)


def main() -> None:
    args = parse_args(sys.argv)
    out = os.path.abspath(args.out)
    print("Building Flexity Freedom →", out)
    reset_scene()

    img_a = paint_livery("cabA")
    img_e = paint_livery("cabE")
    img_m = paint_livery("mid")
    img_d = paint_door()

    mats = {
        "cabA": make_mat("bodyCabA", COL_BODY, 0.42, 0.32, image=img_a),
        "cabE": make_mat("bodyCabE", COL_BODY, 0.42, 0.32, image=img_e),
        "mid": make_mat("bodyMid", COL_BODY, 0.42, 0.32, image=img_m),
        "door": make_mat("doorPanel", COL_BODY, 0.35, 0.40),
        "trim": make_mat("trim", (0.102, 0.106, 0.118), 0.45, 0.55),
        "glass": make_mat("lrvGlass", (0.04, 0.045, 0.05), 0.0, 0.32, alpha=0.92),
        "fairing": make_mat("fairing", (0.52, 0.54, 0.57), 0.45, 0.42),
        "valance": make_mat("valance", (0.04, 0.04, 0.045), 0.30, 0.48),
        "chrome": make_mat("chrome", (0.75, 0.76, 0.78), 0.85, 0.18),
        "dest": make_mat("dest", (0.06, 0.07, 0.08), 0.20, 0.35),
        "glassFront": make_mat("lrvGlassFront", (0.015, 0.017, 0.02), 0.0, 0.48, alpha=1.0),
        "tailLens": make_mat("tailLens", (0.55, 0.05, 0.06), 0.25, 0.15, alpha=0.92),
        "chin": make_mat("chin", COL_BODY, 0.35, 0.32),
        "swoosh": make_mat("swoosh", COL_BLUE, 0.25, 0.40),
        "rubber": make_mat("rubber", (0.07, 0.07, 0.075), 0.05, 0.85),
        "bogie": make_mat("bogie", (0.118, 0.122, 0.133), 0.50, 0.60),
        "interior": make_mat("interior", (0.14, 0.145, 0.155), 0.05, 0.85),
        "dash": make_mat("dash", (0.08, 0.08, 0.09), 0.10, 0.55),
        "seat": make_mat("seat", (0.18, 0.16, 0.16), 0.05, 0.75),
        "lens": make_mat("lens", (0.55, 0.62, 0.70), 0.20, 0.12, alpha=0.85),
        "insulator": make_mat("insulator", (0.85, 0.82, 0.74), 0.05, 0.45),
    }

    # World-root empty is not required; modules and trucks sit at the origin
    # in their own local space (Game / the shot script pose them).
    for i in range(len(MODULES)):
        build_module(i, mats)
        print(f"  built module {MODULES[i]['name']}")

    build_truck("truck-power-A", mats)
    build_truck("truck-trailer", mats)
    build_truck("truck-power-E", mats)
    # Orientation debug marker (Three.js +Z at 1 m from the origin, under cab A)
    new_empty("axis-fwd", (0.0, 0.0, 1.0), parent=bpy.data.objects.get("module-A-cab"))
    new_empty("nose-A", (0.0, 1.0, MODULES[0]["len"] / 2.0),
              parent=bpy.data.objects.get("module-A-cab"))

    n_before = sum(1 for o in bpy.data.objects if o.type == "MESH")
    merge_static_meshes()
    n_after = sum(1 for o in bpy.data.objects if o.type == "MESH")
    print(f"merged static meshes: {n_before} → {n_after} objects")

    export_glb(out)
    print_stats(out)
    print("DONE")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)
