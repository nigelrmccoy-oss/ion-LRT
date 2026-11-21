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

The mesh is original. The v3 shape pass is matched to the CC0 ION Flexity
Freedom photographs (514 side, 504B / 501B front and 3/4): blunt rounded
nose, per-module window/door layout, low roof HVAC and bogie skirts.
Tribute livery only (off-white body, thin charcoal skirt, blue roof band
and A-pillar swoosh, fleet 514, no ION/GRT/Region marks). Those photos,
and the booledozer 2019 opening-day set, show no red/magenta accent, so none
is painted.

Do not copy or ship third-party meshes.

The official glTF exporter needs numpy in Blender's Python. On a distro
Python (PEP 668) install it into Blender's user modules, not system-wide:

```
python3 -m pip install --target ~/.config/blender/4.3/scripts/addons/modules numpy
```
