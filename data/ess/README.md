# ESS geographic qualification data

Drop the Connecticut Energy Storage Solutions (ESS) underserved-geography datasets
here. The backend loads these once at boot and does in-memory point-in-polygon
(same approach as `data/territories-simple.geojson`).

## Expected files (GeoJSON, WGS84 / EPSG:4326)

| File | What | Used for |
|---|---|---|
| `ej-block-groups-2025.geojson` | Environmental Justice Block Groups 2025 (polygons) | point-in-polygon → `inEjBlockGroup` |
| `distressed-municipalities-2025.geojson` | EJ Distressed Municipalities 2025 (polygons) | point-in-polygon → `inDistressedMuni` (+ town name) |

- **Format:** GeoJSON `FeatureCollection`, geographic coords (lng, lat). If you only
  have a **Shapefile** (`.shp/.dbf/.shx/.prj`) or **CSV**, drop them here too and they
  can be converted (`npx -y mapshaper input.shp -o output.geojson`) — or reproject to
  EPSG:4326 first if the shapefile is in CT State Plane.
- **Municipality name:** the distressed-muni features should carry a town-name property.
  The loader looks for any of: `NAME, name, Municipality, MUNICIPALITY, town, TOWN, Town,
  MUNI, GEONAME` (extend `MUNI_NAME_KEYS` in `src/config/ess.ts` if yours differs).
- **Block group id:** optional; read from `GEOID`/`geoid` if present.

Grace-period towns (previously-distressed towns still eligible) are a plain list in
`src/config/ess.ts` → `GRACE_PERIOD_TOWNS` — edit it there.

Files placed here are committed and baked into the backend image (the Dockerfile copies
`data/ess`). `data/*.geojson` at the top level is gitignored, but files under
`data/ess/` are **not** — so they will be tracked.
