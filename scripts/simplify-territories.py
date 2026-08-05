#!/usr/bin/env python3
"""
Simplify the full HIFLD territories GeoJSON (186MB) into a lightweight
version (~3-5MB) suitable for browser map rendering.

- Simplifies polygon geometries (tolerance 0.005 degrees ~= 500m)
- Strips all properties except the ones needed for display
- Outputs to data/territories-simple.geojson

Run: python3 scripts/simplify-territories.py
"""

import json
import sys
from shapely.geometry import shape, mapping
from shapely.validation import make_valid

INPUT = "data/territories.geojson"
OUTPUT = "data/territories-simple.geojson"

KEEP_PROPS = ["NAME", "STATE", "CNTRL_AREA", "HOLDING_CO", "CUSTOMERS", "ID", "REGULATED"]
TOLERANCE = 0.005  # ~500m — good balance of detail vs file size

print(f"Reading {INPUT}...")
with open(INPUT) as f:
    data = json.load(f)

features = data["features"]
print(f"Processing {len(features)} features...")

simplified = []
skipped = 0

for i, feat in enumerate(features):
    try:
        geom = shape(feat["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)

        simple_geom = geom.simplify(TOLERANCE, preserve_topology=True)

        # Skip tiny territories that simplify to nothing
        if simple_geom.is_empty:
            skipped += 1
            continue

        # Keep only needed properties
        props = {}
        for key in KEEP_PROPS:
            if key in feat["properties"]:
                props[key] = feat["properties"][key]

        simplified.append({
            "type": "Feature",
            "properties": props,
            "geometry": mapping(simple_geom)
        })
    except Exception as e:
        print(f"  Warning: skipping feature {i} ({feat['properties'].get('NAME', '?')}): {e}")
        skipped += 1

    if (i + 1) % 500 == 0:
        print(f"  Processed {i + 1}/{len(features)}...")

output = {
    "type": "FeatureCollection",
    "features": simplified
}

print(f"Writing {OUTPUT}...")
with open(OUTPUT, "w") as f:
    json.dump(output, f)

import os
size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
print(f"Done. {len(simplified)} features, {skipped} skipped, {size_mb:.1f} MB")
