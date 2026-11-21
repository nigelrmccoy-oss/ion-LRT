#!/usr/bin/env python3
"""Generate an original ION Flexity Freedom GLB from scratch (Blender 4.3+).

Run from the repo root:

    blender -b -P tools/blender/build_flexity.py -- --out public/models/flexity.glb

The mesh is original work. Shape ideas (raked wraparound nose, rounded roof
shoulders) are inspired by the Gold Coast Flexity 2 as a visual reference only.
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

# Livery (linear-ish sRGB used as Base Color; JPEG/WebP tagged sRGB)
COL_BODY = (0.902, 0.918, 0.937)       # #e6eaef
COL_SKIRT = (0.110, 0.114, 0.125)      # #1c1d20
COL_BAND = (0.165, 0.173, 0.192)       # #2a2c31
COL_BLUE = (0.102, 0.455, 0.784)       # #1a74c8
COL_BLUE_DK = (0.082, 0.373, 0.651)    # #155fa6
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
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
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

def body_profile(n_arc=12, n_side=8) -> list[tuple[float, float]]:
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
    # subtle horizontal grain
    import random
    rng = random.Random(514 if kind != "cabE" else 507)
    for _ in range(1800):
        y = rng.randrange(h)
        boost = 0.04 + rng.random() * 0.07
        c = (min(1, COL_BODY[0] + boost), min(1, COL_BODY[1] + boost), min(1, COL_BODY[2] + boost))
        x0 = 0
        x1 = w
        _fill_rect(px, w, h, x0, y, x1, y + 1, c)

    side_h = int(V_SPLIT * h)
    # skirt (v 0..0.13 of side)
    _fill_rect(px, w, h, 0, 0, w, int(0.13 * side_h), COL_SKIRT)
    _fill_rect(px, w, h, 0, int(0.13 * side_h), w, int(0.145 * side_h), COL_BAND)
    # window band on the sides only
    _fill_rect(px, w, h, 0, int(0.34 * side_h), w, int(0.70 * side_h), COL_BAND)
    # thin blue roof lip at the top of the side island
    _fill_rect(px, w, h, 0, int(0.92 * side_h), w, side_h, COL_BLUE)
    _fill_rect(px, w, h, 0, int(0.915 * side_h), w, int(0.925 * side_h), COL_BLUE_DK)
    # roof island: solid blue, no swoosh
    _fill_rect(px, w, h, 0, side_h, w, h, COL_BLUE)

    if kind in ("cabA", "cabE"):
        # Blue A-pillar swoosh, only on the side island, starting below the roof split
        # so it cannot peek at the roof corners. u=0 rear, u=1 nose tip.
        spine = [
            # (u, v_side 0-1, half-width in v_side). Stop at the body/nose joint
            # (~u 0.73) — the nose A-pillar is a 3D ribbon, not this texture.
            (0.50, 0.90, 0.055),
            (0.60, 0.88, 0.050),
            (0.68, 0.82, 0.045),
            (0.73, 0.78, 0.032),
            (0.745, 0.76, 0.008),
        ]
        # rasterize as a filled tapered band in side-UV pixels
        pts_c, rads = [], []
        for u, vs, hw in spine:
            # clamp vs so the band stays under V_SPLIT
            vs = min(vs, 0.90)
            pts_c.append((u * w, vs * side_h))
            rads.append(hw * side_h)
        # densify and stamp with varying radius
        for i in range(len(pts_c) - 1):
            x0, y0 = pts_c[i]
            x1, y1 = pts_c[i + 1]
            r0, r1 = rads[i], rads[i + 1]
            steps = max(8, int(math.hypot(x1 - x0, y1 - y0)))
            for k in range(steps):
                t = k / steps
                _stamp_disk(px, w, h,
                            x0 + (x1 - x0) * t,
                            y0 + (y1 - y0) * t,
                            r0 + (r1 - r0) * t,
                            COL_BLUE)
        suffix = "A" if kind == "cabA" else "B"
        # Fleet number on the cab side, in the off-white belt below the windows
        # (between door and nose, ~u 0.58).
        _draw_text(px, w, h, f"{FLEET_NO}{suffix}", 0.55, 0.24 * V_SPLIT, 9, COL_NUMBER)

    img = bpy.data.images.new(f"livery-{kind}", width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(px)
    img.pack()
    return img


def paint_door(w: int = 256, h: int = 512) -> bpy.types.Image:
    px = _new_pixels(w, h, (0.102, 0.106, 0.118))
    _fill_rect(px, w, h, 18, int(h * 0.20), w - 18, int(h * 0.72), (0.110, 0.165, 0.212))
    _fill_rect(px, w, h, 28, int(h * 0.55), int((w - 36) * 0.55), int(h * 0.70), (0.55, 0.65, 0.72))
    _fill_rect(px, w, h, 18, int(h * 0.06), w - 18, int(h * 0.28), COL_BODY)
    img = bpy.data.images.new("livery-door", width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(px)
    img.pack()
    return img


# ---------------------------------------------------------------------------
# Face tools: recess, window / windscreen holes, glass
# ---------------------------------------------------------------------------

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
            bm, faces=faces, thickness=0.045, depth=0.0, use_boundary=True, use_even_offset=True,
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

def cab_nose_stations(front: int, half_len: float, nose_len: float, u_at):
    z_joint = front * (half_len - nose_len)
    # Slightly more stations than the procedural mesh, roof held longer, then a
    # firm rake — Flexity 2 shape language, Freedom proportions.
    stations = [
        (0.00, 1.00, Y_BOT, Y_ROOF),
        (0.06, 0.995, Y_BOT, Y_ROOF - 0.015),
        (0.14, 0.985, Y_BOT, Y_ROOF - 0.05),
        (0.22, 0.97, Y_BOT + 0.005, Y_ROOF - 0.12),
        (0.32, 0.93, Y_BOT + 0.01, Y_ROOF - 0.28),
        (0.42, 0.86, Y_BOT + 0.02, Y_ROOF - 0.50),
        (0.52, 0.76, Y_BOT + 0.035, Y_ROOF - 0.82),
        (0.62, 0.64, Y_BOT + 0.06, Y_ROOF - 1.20),
        (0.72, 0.50, Y_BOT + 0.10, Y_BOT + 1.55),
        (0.82, 0.36, Y_BOT + 0.18, Y_BOT + 1.15),
        (0.90, 0.22, Y_BOT + 0.28, Y_BOT + 0.88),
        (0.96, 0.12, Y_BOT + 0.38, Y_BOT + 0.70),
        (1.00, 0.055, Y_BOT + 0.46, Y_BOT + 0.62),
    ]
    base = body_profile()
    rings = []
    for s, sx, yb, yr in stations:
        z = z_joint + front * s * nose_len
        rings.append({"pts": scale_profile(base, sx, yb, yr), "z": z, "u": u_at(z)})
    return rings, z_joint


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
    body_z0 = (-half + NOSE_LEN) if front == -1 else z_rear
    body_z1 = (half - NOSE_LEN) if front == 1 else z_front

    base = body_profile()
    rings: list[dict] = []
    if front == 0:
        nseg = 8 if i != 2 else 5
        for k in range(nseg + 1):
            t = k / nseg
            z = z_rear + (z_front - z_rear) * t
            rings.append({"pts": base, "z": z, "u": u_at(z)})
        cap_start = cap_end = True
    else:
        # body then nose as one continuous loft
        nseg = 6
        if front == 1:
            for k in range(nseg):
                t = k / nseg
                z = z_rear + (body_z1 - z_rear) * t
                rings.append({"pts": base, "z": z, "u": u_at(z)})
            nose, _z_joint = cab_nose_stations(front, half, NOSE_LEN, u_at)
            rings.extend(nose)
        else:
            nose, _z_joint = cab_nose_stations(front, half, NOSE_LEN, u_at)
            rings.extend(nose)  # tip first (s=1 at -half) ... wait, stations go s=0 (joint) to s=1 (tip)
            # For cab E, z_joint is negative-ish and tip is at -half. Stations already
            # go joint → tip, so rings currently start at the joint and go to the tip.
            # We need rear-of-body (the +z end) → joint → tip, then cap tip + body end.
            body_rings = []
            for k in range(nseg):
                t = k / nseg
                # from +half (body end, "rear" toward D) down to body_z0 (joint)
                z = z_front + (body_z0 - z_front) * t
                body_rings.append({"pts": base, "z": z, "u": u_at(z)})
            # nose stations already joint→tip; skip first if it duplicates the joint
            rings = body_rings + nose
        cap_start = True
        cap_end = True

    bm = loft_shell(rings, cap_start, cap_end)

    # Recessed door pockets (not on the centre module)
    door_z = 0.0 if not is_cab else (-1.4 if i == 0 else 1.4)
    door_half = 0.68
    if i != 2:
        y0, y1 = LRV_FLOOR + 0.02, LRV_FLOOR + 2.05
        for side in (-1.0, 1.0):
            recess_door_region(bm, side, door_z, door_half, y0, y1, depth=0.10)

    # Side-window openings
    win_h = 0.95
    win_y = LRV_FLOOR + 1.55
    panes: list[tuple[float, float]] = []  # (z, len)
    if is_cab:
        z_a = (half - NOSE_LEN - 0.15) if i == 0 else -(half - NOSE_LEN - 0.15)
        z_door_front = door_z + (door_half if i == 0 else -door_half)
        mid = (z_a + z_door_front) / 2.0
        ln = abs(z_a - z_door_front) - 0.10
        if ln > 0.4:
            panes.append((mid, ln))
    elif i != 2:
        span = (body_z1 - body_z0) / 2.0 - door_half - 0.15
        if span > 0.4:
            panes.append((-door_half - 0.12 - span / 2.0, span))
            panes.append((door_half + 0.12 + span / 2.0, span))
    else:
        panes.append((0.0, max(0.5, length - 1.0)))

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

    # Windscreen hole is cut later with a smooth boolean (loft-face delete
    # left a sawtooth opening). Glass is added the same way.

    body_mesh = mesh_from_bm(f"{name}-body", bm)
    bm.free()
    body_obj = new_obj("body", body_mesh, body_mat, root)
    if is_cab:
        _cut_windscreen(body_obj, front, half, root, mats)

    # Merge glass bmeshes
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

    # Window frames (thin boxes around each side pane)
    for pz, plen in panes:
        for side in (-1.0, 1.0):
            add_box(f"frame-{i}-{side}-{pz:.2f}", 0.025, win_h + 0.06, plen + 0.06,
                    side * (HALF_W + 0.006), win_y, pz, mats["trim"], root)

    # Roof pods / fairings
    z_mid = (body_z0 + body_z1) / 2.0 if front != 0 else 0.0
    if i != 2:
        pod_len = min(2.6, max(0.8, (body_z1 - body_z0) * 0.55))
        add_rounded_box("hvac-pod", LRV_WIDTH * 0.52, 0.22, pod_len,
                        0.0, Y_ROOF + 0.11, z_mid, mats["fairing"], root, radius=0.07, seg=3)
        add_uvsphere("hvac-cap", LRV_WIDTH * 0.26, 0.12, pod_len * 0.48,
                     0.0, Y_ROOF + 0.20, z_mid, mats["fairing"], root, segs=14, rings=7)
        # small boxes / antenna
        add_rounded_box("roof-box", 0.35, 0.10, 0.45,
                        0.35, Y_ROOF + 0.16, z_mid - pod_len * 0.25,
                        mats["fairing"], root, radius=0.03, seg=2)
        add_cyl("antenna", 0.012, 0.28, -0.40, Y_ROOF + 0.28, z_mid + pod_len * 0.20,
                "y", mats["trim"], root, segs=8)
    else:
        add_rounded_box("roof-well", LRV_WIDTH * 0.42, 0.12, 1.6,
                        0.0, Y_ROOF + 0.06, 0.0, mats["fairing"], root, radius=0.05, seg=2)

    # Dest sign + lamp anchors + headlight housings + interior (cabs)
    if is_cab:
        z_joint = front * (half - NOSE_LEN)
        dest = add_box(f"destSign-{'A' if i == 0 else 'E'}", 1.62, 0.20, 0.08,
                       0.0, Y_ROOF - 0.12, z_joint + front * 0.22,
                       mats["trim"], root)
        dest.name = f"destSign-{'A' if i == 0 else 'E'}"

        # Housings sit on the body where the nose is still ~2 m wide (s ≈ 0.52),
        # not at the tip where the shell has already tapered inside ±0.84 m.
        y_lamp = 0.70
        z_lamp = z_joint + front * 0.52 * NOSE_LEN
        x_lamp = 0.84
        for sx, tag in ((-1, "L"), (1, "R")):
            aname = f"lampAnchor-head-{tag}" if front > 0 else f"lampAnchor-tail-{tag}"
            new_empty(aname, (sx * x_lamp, y_lamp, z_lamp), parent=root,
                      rot_z=(math.pi if front < 0 else 0.0))
            add_rounded_box(f"lamp-house-{tag}", 0.22, 0.16, 0.18,
                            sx * x_lamp, y_lamp, z_lamp - front * 0.04,
                            mats["trim"], root, radius=0.03, seg=2)
            add_cyl(f"lamp-lens-{tag}", 0.055, 0.04,
                    sx * x_lamp, y_lamp, z_lamp + front * 0.06,
                    "z", mats["lens"], root, segs=16)
            add_cyl(f"marker-{tag}", 0.025, 0.03,
                    sx * x_lamp, y_lamp + 0.13, z_lamp + front * 0.02,
                    "z", mats["lens"], root, segs=10)

        # Chin / coupler valance
        add_rounded_box("coupler-valance", 0.55, 0.22, 0.30,
                        0.0, Y_BOT + 0.28, front * (half - 0.10),
                        mats["trim"], root, radius=0.04, seg=2)

        _add_cab_interior(root, front, half, z_joint, mats)
        _add_swoosh(root, front, half, z_joint, mats)

    # Plug doors (separate nodes so Game.setDoorsVisual can slide them)
    if i != 2:
        for side in (-1, 1):
            _add_door(root, i, side, door_z, mats)

    # Bellows on the rear face of every module except E
    if i < len(MODULES) - 1:
        _add_bellows(root, -length / 2.0, mats)

    # Pantograph on the centre module
    if i == 2:
        _add_pantograph(root, mats)

    # Simple dark floor / ceiling liner so holes don't show a hollow white shell
    add_box("floor-liner", LRV_WIDTH * 0.84, 0.03, max(0.4, (body_z1 - body_z0) - 0.1),
            0.0, LRV_FLOOR + 0.04, (body_z0 + body_z1) / 2.0, mats["interior"], root)
    add_box("ceiling-liner", LRV_WIDTH * 0.70, 0.03, max(0.4, (body_z1 - body_z0) - 0.1),
            0.0, Y_ROOF - 0.18, (body_z0 + body_z1) / 2.0, mats["interior"], root)

    return root



def _cut_windscreen(body_obj, front, half, parent, mats) -> None:
    """Boolean a smooth raked opening and fill it with wraparound glass."""
    z_joint = front * (half - NOSE_LEN)
    # Cutter sits in the glass band, raked to the nose, with rounded corners.
    cx, cy, cz = 0.0, 1.85, z_joint + front * 0.42 * NOSE_LEN
    rake = -0.50 if front > 0 else 0.50
    cutter = add_rounded_box("ws-cutter", 2.05, 1.45, 0.85,
                             cx, cy, cz, mats["trim"], parent=None,
                             radius=0.16, seg=4)
    cutter.rotation_euler = _rot_x_as_blender(rake)
    cutter.display_type = "WIRE"
    mod = body_obj.modifiers.new("windscreen", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    try:
        mod.solver = "EXACT"
    except Exception:
        pass
    mod.object = cutter
    applied = False
    try:
        bpy.context.view_layer.objects.active = body_obj
        body_obj.select_set(True)
        with bpy.context.temp_override(object=body_obj, active_object=body_obj):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        applied = True
    except Exception as exc:
        print(f"  windscreen boolean apply failed: {exc}")
    if not applied:
        try:
            body_obj.modifiers.remove(mod)
        except Exception:
            pass
    bpy.data.objects.remove(cutter, do_unlink=True)

    # Wraparound glass: a raked, slightly bulged grid just outside the opening.
    gbm = bmesh.new()
    nu, nv = 20, 12
    verts = []
    wrap_r = 2.4
    for j in range(nv + 1):
        tv = j / nv
        y = 1.20 + tv * 1.40
        row = []
        for i in range(nu + 1):
            tu = i / nu
            x = (tu - 0.5) * 1.95
            # bulge outward + wrap
            bulge = 0.04 + 0.10 * (1.0 - (x / 1.05) ** 2) * (4.0 * tv * (1.0 - tv))
            wrap = -(x * x) / (2.0 * wrap_r)
            s = 0.22 + tv * 0.28  # along the nose
            z = z_joint + front * (s * NOSE_LEN + wrap + bulge)
            # rake: shift z a little with y
            z += front * (y - 1.85) * (-0.35 if front > 0 else 0.35)
            row.append(gbm.verts.new(to_b(x, y, z)))
        verts.append(row)
    gbm.verts.ensure_lookup_table()
    for j in range(nv):
        for i in range(nu):
            try:
                gbm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
            except ValueError:
                continue
    glass_mesh = mesh_from_bm("windscreen-glass", gbm)
    gbm.free()
    new_obj("windscreen", glass_mesh, mats["glass"], parent)


def _add_door(parent, i, side, door_z, mats) -> None:
    tag = "L" if side < 0 else "R"
    cab = {0: "A", 4: "E"}.get(i, "M")
    group = new_empty(f"door-{cab}-{tag}", (side * (LRV_WIDTH / 2 + 0.00), LRV_FLOOR + 1.0, door_z), parent)
    # Recessed: sit a little inboard of the outer skin
    group.location = Vector(to_b(side * (LRV_WIDTH / 2 - 0.04), LRV_FLOOR + 1.0, door_z))
    panel = add_box("door-panel", 0.05, 2.0, 1.30, 0, 0, 0, mats["door"], group)
    # Window in the door
    glass = add_box("door-glass", 0.02, 1.10, 1.12, side * 0.03, 0.25, 0, mats["glass"], group)
    # custom properties for glTF extras (assembler also derives from position)
    group["side"] = int(side)
    group["baseX"] = float(side * (LRV_WIDTH / 2 - 0.04))
    group["baseZ"] = float(door_z)


def _add_bellows(parent, bel_z, mats) -> None:
    bel_h = (Y_ROOF - Y_BOT) * 0.92
    bel_y = Y_BOT + 0.04 + bel_h / 2.0
    n_folds = 8
    span = 0.42
    for r in range(n_folds):
        t = r / (n_folds - 1)
        z = bel_z - span / 2.0 + t * span
        # Alternate scale to read as corrugation
        fat = 1.0 if r % 2 == 0 else 0.88
        add_rounded_box(f"bellows-{r}", LRV_WIDTH * 0.88 * fat, bel_h, 0.045,
                        0.0, bel_y, z, mats["rubber"], parent, radius=0.02, seg=1)


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
    """Blue A-pillar ribbon on the lofted nose, tucked below the roof line."""
    from mathutils import Matrix
    for sx in (-1.0, 1.0):
        pts = [
            # Start well below the roof line so the ribbon cannot peek at the corners.
            (sx * (HALF_W - 0.10), Y_ROOF - 0.36, z_joint + front * 0.12),
            (sx * (HALF_W - 0.12), Y_ROOF - 0.48, z_joint + front * 0.34),
            (sx * HALF_W * 0.70, Y_ROOF - 0.85, z_joint + front * 0.62),
            (sx * HALF_W * 0.42, 1.15, z_joint + front * 0.95),
            (sx * 0.22, 0.80, z_joint + front * 1.20),
        ]
        curve_data = bpy.data.curves.new(f"swoosh-crv-{sx}", "CURVE")
        curve_data.dimensions = "3D"
        curve_data.bevel_depth = 0.024
        curve_data.bevel_resolution = 3
        curve_data.resolution_u = 12
        spline = curve_data.splines.new("NURBS")
        spline.points.add(len(pts) - 1)
        for i, (x, y, z) in enumerate(pts):
            bx, by, bz = to_b(x, y, z)
            spline.points[i].co = (bx, by, bz, 1.0)
        spline.use_endpoint_u = True
        spline.order_u = min(4, len(pts))
        obj = bpy.data.objects.new(f"swoosh-{sx}", curve_data)
        obj.data.materials.append(mats["swoosh"])
        obj.parent = parent
        bpy.context.collection.objects.link(obj)
        # Convert to mesh so export and merge-by-material see a real mesh
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
    # Rear bulkhead just inside the body / nose joint
    add_box("cab-bulkhead", LRV_WIDTH * 0.90, 2.4, 0.05,
            0.0, LRV_FLOOR + 1.25, z_joint - front * 0.12,
            mats["interior"], parent)
    # Floor in the nose
    nose_mid = z_joint + front * (NOSE_LEN * 0.35)
    add_box("cab-floor", LRV_WIDTH * 0.70, 0.04, NOSE_LEN * 0.7,
            0.0, LRV_FLOOR + 0.08, nose_mid, mats["interior"], parent)
    # Dashboard, raked to follow the windscreen
    dash = add_box("cab-dash", 1.70, 0.22, 0.35,
                   0.0, 1.05, z_joint + front * (NOSE_LEN * 0.38),
                   mats["dash"], parent)
    dash.rotation_euler = _rot_x_as_blender((-0.35 if front > 0 else 0.35))
    # Two seat backs (operator on the right, Canadian practice)
    for sx, tag in ((0.50, "R"), (-0.50, "L")):
        add_rounded_box(f"seat-{tag}", 0.42, 0.70, 0.18,
                        sx, 0.85, z_joint + front * 0.10,
                        mats["seat"], parent, radius=0.04, seg=2)
        add_rounded_box(f"seat-base-{tag}", 0.42, 0.10, 0.40,
                        sx, 0.55, z_joint + front * 0.22,
                        mats["seat"], parent, radius=0.03, seg=2)
    # Master-controller pedestal (right)
    add_cyl("controller", 0.05, 0.35, 0.42, 0.95, z_joint + front * 0.32,
            "y", mats["trim"], parent, segs=8)
    # Sun-visor / header above the windscreen, inside
    add_box("sun-visor", 1.6, 0.06, 0.16,
            0.0, 2.55, z_joint + front * (NOSE_LEN * 0.18),
            mats["interior"], parent)


def build_truck(kind: str, mats) -> bpy.types.Object:
    root = new_empty(kind, (0, 0, 0))
    add_rounded_box("truck-frame", 1.70, 0.28, 2.35,
                    0.0, 0.38, 0.0, mats["bogie"], root, radius=0.04, seg=2)
    for sx in (-1.0, 1.0):
        add_box("sideframe", 0.08, 0.38, 2.55, sx * 1.02, 0.36, 0.0, mats["bogie"], root)
    for zz in (-0.925, 0.925):
        for xx in (-0.72, 0.72):
            # Wheel + faint flange
            add_cyl("wheel", 0.33, 0.12, xx, 0.33, zz, "x", mats["bogie"], root, segs=20)
            add_cyl("flange", 0.36, 0.03, xx + (0.07 if xx > 0 else -0.07), 0.33, zz,
                    "x", mats["bogie"], root, segs=20)
    return root


# ---------------------------------------------------------------------------
# Export + stats
# ---------------------------------------------------------------------------

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
               or o.name == "pantograph"]
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
        "door": make_mat("doorPanel", (0.16, 0.17, 0.19), 0.35, 0.45, image=img_d),
        "trim": make_mat("trim", (0.102, 0.106, 0.118), 0.45, 0.55),
        "glass": make_mat("lrvGlass", (0.102, 0.157, 0.200), 0.15, 0.08, alpha=0.58),
        "fairing": make_mat("fairing", (0.867, 0.886, 0.910), 0.40, 0.38),
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
