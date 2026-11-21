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

The mesh is original. The v4 shape pass rebuilds the cab front as its own
swept part (nearly vertical, slight rake, wraparound windscreen with the
destination sign in the glass, blue A-pillar band, white chin, headlight
clusters and a black valance) and gives each module tall, almost-continuous
side glass with full-height glazed plug doors. The blue roof is a thin cap
with a defined edge. Tribute livery only (off-white body, thin charcoal
skirt, blue roof cap and A-pillar swoosh, fleet 514, no ION/GRT/Region
marks). Those photos, and the booledozer 2019 opening-day set, show no
red/magenta accent, so none is painted.

Do not copy or ship third-party meshes.

The official glTF exporter needs numpy in Blender's Python. On a distro
Python (PEP 668) install it into Blender's user modules, not system-wide:

```
python3 -m pip install --target ~/.config/blender/4.3/scripts/addons/modules numpy
```
