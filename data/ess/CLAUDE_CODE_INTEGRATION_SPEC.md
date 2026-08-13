# GridShift — CT MFAH Dataset Integration + Qualification Engine Spec

Hand this file to Claude Code as the task brief. It covers (1) where the dataset lives and its schema, (2) how to load it into the platform, and (3) the exact, unambiguous qualification rules for CT ESS and the Federal ITC to encode as the matching/scoring logic.

---

## 1. Dataset to integrate

**File:** `CT_MFAH_Master_List.csv`
**Row count:** 2,432 unique properties (deduplicated from 2,667 raw records across 3 sources)
**Total units:** 66,018

### Source composition
| Source | Properties | Units | Coverage |
|---|---|---|---|
| HUD LIHTC Database | 393 | 27,636 | CT LIHTC properties, 5+ units only |
| HUD Multifamily/Section 8 (`egis.hud.gov/.../MultifamilyProperties`) | 409 | 32,068 | Section 8 project-based + HUD-insured multifamily |
| HUD Public Housing (`egis.hud.gov/.../PublicHousing`) | 1,865 | 13,221 | PHA-owned public housing buildings |

### CSV schema
```
project_name          text
address               text
city                  text
zip                   text
units                 integer
sources               text   -- semicolon-delimited: "LIHTC", "Section8_Multifamily", "Public_Housing"
owner_operator         text   -- populated only for Section8_Multifamily rows
contact_email          text   -- populated only for Section8_Multifamily rows
multi_program_overlap text   -- "Yes"/"No" — property matched across >1 source by normalized address
```

### Known data limitations — do not treat as fully clean
1. **No lat/long on 567 rows** — only the Public Housing source (1,865 rows) carries geometry natively. LIHTC and Section8_Multifamily rows need geocoding (Census Geocoder API, free, no key required) before they can be mapped or spatially joined to DECD/EJ/tract layers.
2. **51 LIHTC properties statewide have no unit count** in the original HUD export (excluded from this file entirely — they didn't clear the 5+ unit qualification filter because units were unknown, not because they failed it). Re-pull from huduser.gov/lihtc with "Year Placed in Service" and unit fields explicitly selected to recover these.
3. **Dedup is address-string-based, not authoritative** — 42 properties are flagged `multi_program_overlap = Yes`. Spot-check these; a few (e.g. "122 WILMOT RD, NEW HAVEN") appear twice *within the same source*, which may indicate a genuine duplicate LIHTC filing (phased development) rather than a cross-program match. Do not assume `units` (max across duplicates) is authoritative without a manual pass on the top 50 by unit count.
4. **No DECD distressed-municipality tag yet.** Official current list is a binary `.xlsx` at `portal.ct.gov/DECD/.../Distressed-Municipalities` — not machine-fetchable from this environment. Download it manually and feed it into the loader (see Section 3).
5. **No metering-type flag.** Master-metered properties may not qualify at the residential CT ESS rate at all (falls to C&I rate). This dataset does not distinguish individually-metered from master-metered — that remains a per-property verification step, not something inferable from these three sources.

---

## 2. Suggested integration (matches existing platform architecture: Next.js + DO Managed Postgres)

### 2.1 Load into Postgres

```sql
CREATE TABLE mfah_properties (
    id                    SERIAL PRIMARY KEY,
    project_name          TEXT,
    address               TEXT NOT NULL,
    city                  TEXT NOT NULL,
    zip                   TEXT,
    units                 INTEGER,
    sources               TEXT[],           -- parse semicolon-delimited string into array on load
    owner_operator        TEXT,
    contact_email         TEXT,
    multi_program_overlap BOOLEAN,
    latitude              NUMERIC,           -- NULL until geocoded
    longitude             NUMERIC,           -- NULL until geocoded
    census_tract_fips     TEXT,              -- NULL until geocoded
    is_distressed_municipality BOOLEAN,      -- NULL until DECD list loaded
    is_ej_block           BOOLEAN,           -- NULL until DEEP EJ layer joined
    is_grid_edge          BOOLEAN,           -- NULL — source unresolved, see Section 3.1
    ess_tier              TEXT,              -- computed: 'Standard' | 'Underserved' | 'Low-Income'
    itc_stack_pct         NUMERIC,           -- computed
    created_at            TIMESTAMP DEFAULT now(),
    updated_at            TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_mfah_city ON mfah_properties (city);
CREATE INDEX idx_mfah_units ON mfah_properties (units DESC);
```

### 2.2 Loader script (Claude Code: build this)
- Parse `sources` column into a Postgres array on insert.
- Run every row through the Census Geocoder (`geocoding.geo.census.gov/geocoder/locations/onelineaddress`) to backfill `latitude`, `longitude`, `census_tract_fips`. This is the single highest-leverage enrichment step — it unlocks every downstream tract-based lookup (EJ, NMTC, Energy Community).
- After geocoding, run the ESS/ITC qualification functions below to populate `ess_tier` and `itc_stack_pct`.

### 2.3 Follow-up data feeds to wire in later
- DECD distressed municipality list (manual download → simple town-name lookup table → join)
- CT DEEP EJ Communities layer (ArcGIS: `ctdeep.maps.arcgis.com/apps/webappviewer/index.html?id=03b2bc2b60c945918ccab5a9f6bc43ea`)
- DOE/NETL Energy Communities layer (`arcgis.netl.doe.gov/portal/apps/experiencebuilder/experience/?id=a2ce47d4721a477a8701bd0e08495e1d`)
- CDFI NMTC low-income tract lookup (`cimsprodprep.cdfifund.gov/CIMS4/apps/pn-nmtc/index.aspx`)
- Grid Edge circuit designation — **source still unresolved**, open question with CT Green Bank (see Section 3.1)

---

## 3. Exact qualification logic — CT ESS Program

Implement as a pure function: `getESSTier(property) -> { enrollment_rate, performance_rate, tier_name }`

### 3.1 Enrollment incentive (one-time, at commissioning)

```
IF property.is_grid_edge == true:
    enrollment_rate = $130/kWh
ELSE:
    enrollment_rate = $30/kWh
```

**⚠️ Implementation blocker:** `is_grid_edge` has no confirmed programmatic source yet. The map at `eversource.maps.arcgis.com/apps/webappviewer/index.html?id=2f0c365e197f4ce0b9ddf4c988d2ea57` resolves to Eversource's general **DG Hosting Capacity Map** — a different, broader engineering dataset, not a Grid Edge-specific designation. The CT-ESS-specific "Grid Edge Map — Zip Code Table" referenced in the ESS Manual has not been confirmed as downloadable. Treat `is_grid_edge` as `NULL`/unknown for all properties until this is resolved directly with CT Green Bank (energystorage@ctgreenbank.com). Do not default it to `false` — surface it as "unconfirmed" in the UI rather than silently assuming Standard rate.

### 3.2 Performance incentive (10-year annual payment, Active Dispatch only — mandatory for all new enrollments post-4/1/26)

Evaluate in this exact priority order (Low-Income supersedes Underserved if both apply; Underserved supersedes Standard):

```
IF property.household_income <= 0.60 * state_median_income:
    tier = "Low-Income"
    performance_rate = $525–550/kW-yr

ELSE IF property.is_MFAH == true
     AND property.units >= 5
     AND property.MFAH_tier IN ("Tier I", "Tier II", "Tier III"):
    tier = "Low-Income"
    performance_rate = $525–550/kW-yr
    verification_required = false   # <-- auto-qualifies, this is the master dataset's primary use case

ELSE IF property.town IN DECD_distressed_municipality_list
     OR property.is_ej_block == true:
    tier = "Underserved"
    performance_rate = $425–450/kW-yr

ELSE:
    tier = "Standard"
    performance_rate = $300/kW-yr
```

**MFAH auto-qualification test** (the branch that applies to every row in `CT_MFAH_Master_List.csv`):
```
is_MFAH_qualifying(property):
    return (
        property.units >= 5
        AND ("LIHTC" IN property.sources
             OR "Public_Housing" IN property.sources
             OR "Section8_Multifamily" IN property.sources)
    )
```
This is a **pure property-level test — no per-tenant income documentation required.** Every row already in the master dataset that has `units >= 5` passes this test by construction (that filter was already applied when the LIHTC subset was built; Public_Housing and Section8_Multifamily rows should be filtered to `units >= 5` in the loader if not already).

**DECD distressed municipality list:** simple town-name string match against the official annual list (see Section 2.3 — not yet loaded).

**MFAH tenant resiliency sharing (separate compliance gate, not a data-lookup):** CT ESS additionally requires the TPO demonstrate tenants receive a "fair and equitable portion" of backup power during outages. This is a program filing/compliance requirement, not something derivable from the dataset — flag it as a required manual step in the deal pipeline, not a boolean field.

---

## 4. Exact qualification logic — Federal ITC (Section 48E)

Implement as: `getITCStack(property) -> { base_pct, adders: [...], total_pct }`

```
base_pct = 30%
    # Auto-applies to all projects under 1 MW — prevailing wage/apprenticeship
    # requirements are automatically exempted below 1 MW. Residential and
    # small MFAH systems (single-digit to low-double-digit kW) never trigger
    # this compliance burden. Do not build wage-verification logic for
    # anything under 1 MW aggregate capacity.

adders = []

IF hardware_sku == "B05-C01-US00-1-3-DOM":   # Enphase IQ Battery 10C DOM SKU
    adders.append(("Domestic Content", +10%))

IF property.census_tract IN energy_community_tracts:   # DOE/NETL lookup
    adders.append(("Energy Community", +10%))

# Cat 1 / Cat 3 are MUTUALLY EXCLUSIVE — evaluate both, pick the higher available one
cat1_eligible = property.census_tract IN nmtc_low_income_tracts        # CDFI lookup — LOCATION-ONLY test
cat3_eligible = (
    property.is_MFAH_qualifying == true                                 # building's own affordable-housing status
    AND benefit_sharing_plan_confirms_50pct_to_residents == true         # structural/compliance test, not geographic
)

IF cat3_eligible:
    adders.append(("LI Community Cat 3", +20%))
ELSE IF cat1_eligible:
    adders.append(("LI Community Cat 1", +10%))
# IF NEITHER cat1_eligible NOR cat3_eligible: no LI Community adder available.
# Cat 1 requires physical tract location — there is no substitute path via
# MFAH status alone. Cat 3 is the only door open for an MFAH property that
# sits outside a qualifying tract.

total_pct = base_pct + sum(adder percentages)
```

**Critical distinction to encode correctly:** Cat 1 eligibility is purely geographic (tract lookup, no compliance burden). Cat 3 eligibility is purely structural (building's affordable-housing status + benefit-sharing demonstration, no tract requirement). They test completely different things and are not layered — a property either qualifies for one, the other, both (pick higher = Cat 3), or neither.

**DOE allocation cap constraint (Cat 1 and Cat 3 both):** Both categories are subject to competitive annual DOE capacity allocation (600 MW national cap for Cat 1 category types, 200 MW for Cat 3), not guaranteed availability. `getITCStack()` should return the *theoretical* eligible stack; actual award is subject to a separate DOE application process each program year (2026 window: Feb 2–Aug 7) and should be tracked as a pipeline status field, not assumed automatic like the CT ESS LI tier is.

---

## 5. Action items for Claude Code

1. Write the Postgres schema + loader (Section 2.1–2.2), parsing `CT_MFAH_Master_List.csv`.
2. Wire in Census Geocoder batch job to backfill lat/long + tract FIPS for all 2,432 rows.
3. Implement `getESSTier()` and `getITCStack()` exactly as specified in Sections 3–4 as pure, testable functions — do not embed this logic ad hoc in UI components.
4. Leave `is_grid_edge` as a nullable/unconfirmed field with a visible "pending verification" state in any UI that surfaces it — do not silently default to Non-Grid-Edge.
5. Build a manual-review flag/queue for the 42 `multi_program_overlap = Yes` properties before they're used in any external-facing pipeline or investor materials.
6. Once the DECD `.xlsx` list is manually downloaded, write a small ingestion script to populate `is_distressed_municipality` via town-name match.
