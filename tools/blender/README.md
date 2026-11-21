# Flexity Freedom GLB generator

Headless Blender 4.3+ script that builds an original 5-module ION Flexity
Freedom and writes `public/models/flexity.glb`.

From the repo root:

```
blender -b -P tools/blender/build_flexity.py -- --out public/models/flexity.glb
```

On nigian, wrap heavy bakes:

```
timeout 15m flock /tmp/nigian-heavy-tests.lock \
  /usr/bin/blender -b -P tools/blender/build_flexity.py -- --out public/models/flexity.glb
```

The mesh is original. The v6 shape pass keeps the separate swept cab front
and adds tumblehome, a slightly bowed plan, and a wide flush ION royal-blue
(#1f4fa0) C-band that grows out of the roof edge and runs down the A-pillars
to the chin, thick in 3/4 like 501B/504B, meeting the glass with no white
brow (matched to 504B head-on / 501B 3/4). Untextured base colors are
converted to scene-linear so the glTF material does not wash to cyan.
A black lamp/number panel under the glass carries a legible 514A / 514B.
Side glass stays tall and almost continuous, with full-height glazed plug
doors. The blue roof is a thin cap with a defined edge. Tribute livery only
(off-white body, thin charcoal skirt, blue roof cap and A-pillar C-band,
fleet 514, no ION/GRT/Region marks). Those photos, and the booledozer 2019
opening-day set, show no red/magenta accent, so none is painted.

Do not copy or ship third-party meshes.

The official glTF exporter needs numpy in Blender's Python. On a distro
Python (PEP 668) install it into Blender's user modules, not system-wide:

```
python3 -m pip install --target ~/.config/blender/4.3/scripts/addons/modules numpy
```
