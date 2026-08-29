# CT Battery Solutions — Backend Reference

Express 4 + TypeScript + Prisma + PostgreSQL. Layered: `routes/` (HTTP only) →
`services/` (logic + all Prisma) → `config/database.ts` (single client). See root
`CLAUDE.md` for conventions.

## Run locally

```bash
# Postgres (Homebrew) must be running:
#   brew services start postgresql@16
#   role "ctbs" / db "ct_battery_solutions" (see .env)
cp .env.example .env            # then fill secrets
npm install
npx prisma migrate dev          # apply migrations
npm run import:enrichment       # 5 target utilities
npm run import:tariffs          # 41,810 C&I tariffs (needs data/usurdb.json)
npm run dev                     # ts-node + nodemon on :3000
curl localhost:3000/health
curl localhost:3000/api         # endpoint index
```

`data/usurdb.json` (177 MB) and the full `territories.geojson` are gitignored — download
USURDB via the command in `src/scripts/import-tariffs.ts`. `data/territories-simple.geojson`
(4.8 MB) is committed and loaded in-memory for point-in-polygon.

## Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /health` | — | Liveness (raw `{status:'OK'}`) |
| `GET /api` | — | Self-documenting endpoint index |
| `POST /api/auth/login` | — | Firebase ID token → API JWT (7d). 500 `FIREBASE_NOT_CONFIGURED` if unset |
| `GET /api/auth/me` | JWT | Current user |
| `POST /api/lookup` | — | `{lat,lng,address?}` **or** `{address}` → utility + eligibility + enrichment + tariff defaults |
| `GET /api/territories` | — | Raw utility-territory GeoJSON (map), cached |
| `GET /api/tariffs?utility=&page=&limit=` | — | Paginated C&I tariffs (shaped) |
| `POST /api/analyze` | — | BESS 8-stream savings model (`analyze.service`) |
| `POST /api/applications` | — (rate-limited) | Submit a consumer application → `{applicationNumber,status}` |
| `POST /api/applications/:id/panel-photo` | — (rate-limited) | Upload panel photo → Spaces (`STORAGE_NOT_CONFIGURED` until set) |
| `GET /api/applications?page=&limit=&status=` | JWT ADMIN/OWNER | Paginated list |
| `GET /api/applications/:id` | JWT ADMIN/OWNER | Detail |
| `PATCH /api/applications/:id` | JWT ADMIN/OWNER | `{status}` update |
| `GET /api/lifecycle/map` | — | State-machine map (stages, gates, block codes, clocks, transitions) projected from the seed tables + `TRANSITIONS` |
| `POST /api/systems/:id/advance` | JWT ADMIN/OPS | Advance one stage. `{via:MANUAL\|OVERRIDE, reason?}`. 422 `GATE_UNMET` returns `{gate, unmet:[{key,label,owner_role}]}` |
| `POST /api/systems/:id/block` | JWT ADMIN/OPS | `{code, note?}` — code must belong to the current stage |
| `POST /api/systems/:id/unblock` | JWT ADMIN/OPS | Clear the block |
| `POST /api/systems/:id/terminal` | JWT ADMIN | `{state, reason, acknowledge_clawback?}`. Stage preserved; REMOVED in recapture → 409 `RECAPTURE_WINDOW` + `clawback_amount` |
| `PATCH /api/systems/:id/checklist` | JWT ADMIN/OPS/FIELD | `{key, state, doc_id?}`; may fire an AUTO advance. Auto-only items (telemetry/DERMS) → 403 |
| `POST /api/systems/:id/docs` | JWT ADMIN/OPS/FIELD | multipart; ROF/COF letters write the date and fire the AUTO chain |
| `POST /api/systems/:id/turnover` | JWT ADMIN/OPS | Open a turnover case + TURNOVER flag |

Response envelope: `{success:true,data,pagination?}` / `{success:false,code,message}`.
`/health` and `/api/territories` return raw documents (no envelope).

## Models (prisma/schema.prisma)

- **User** — admin (firebaseUid, email, role ADMIN|OWNER).
- **Application** — consumer submission; one table, grouped nullable sections; enums for
  `status` (LEAD|SUBMITTED|RENTER_PENDING|SURVEY_SCHEDULED|SIGNED), `eligibilityKind`,
  `ownerOutreachMode`. Status is derived in `application.service.ts#deriveStatus`.
  `applicationNumber` = `CTB-YYYY-#####` (generated, unique).
- **RateTariff** — 41,810 USURDB C&I rows; nested rate structures as `Json`. Uncontrolled
  text columns (utilityName, rateName, serviceType, sourceUrl) are unbounded to avoid P2000.
- **UtilityEnrichment** — 5 curated target utilities; unique on `(utilityName, state)`.

## Key services

- **territory.service** — loads simplified GeoJSON once; `resolveTerritory(lat,lng)` via
  `@turf/boolean-point-in-polygon`. No PostGIS.
- **lookup.service** — orchestrates territory → enrichment join → eligibility. With coords:
  full resolution. Address-only (apply flow): CT detected from the address string,
  PRIORITY if a distressed municipality (`constants/eligibility.ts`), else STANDARD; non-CT
  → INELIGIBLE.
- **enrichment.service** / **tariff.service** — shape Prisma rows into the snake_case
  contracts the web cards already expect; tariff service extracts best-effort
  `_effective_demand_charge` and `_tou_spread` from JSON rate structures.
- **application.service** — create / list / get / updateStatus.
- **lib/lifecycle** — the state machine (02-STATE-MACHINE). One gate validator
  (`gates.ts#evaluateGate`) + one advance primitive drive every caller. `machine.ts`
  exposes `advance` (MANUAL/OVERRIDE) plus AUTO trigger entry points the pollers / field
  app / docs endpoint call (`onRofLogged`, `onCofLogged`, `onWorkOrderCheckin/Checkout`,
  `onTelemetryConfirmed`, `onDermsVisible`, `onSnapshotWritten`) — all funnel into
  `runAutoChain`, which steps while the next transition is AUTO and its gate passes
  (each AUTO gate **is** its trigger predicate). `stage_history`'s unique
  `(system_id, from, to)` makes duplicate fires idempotent no-ops. On-enter effects
  (`effects.ts`) do the real data work (checklist instantiation, rate lock + ITC claim
  ACCRUING at S05, BASIS_LOCKED + ENROLL_INC ledger + PIS/recapture dates at OPERATING);
  external effects (SMS/DocuSign/PDF/poller arms) are stubbed behind `notifications.ts`.
  `TRANSITIONS` (`transitions.ts`) is the locked map — do not add transitions beyond it.
  `map.ts` projects the seed tables for `GET /api/lifecycle/map`. Integration test:
  `npm run test:lifecycle` (drives S01→OPERATING through the public surface).

## Gotchas

- `ts-node` needs `"ts-node":{"files":true}` in tsconfig so the ambient `src/types/express.d.ts`
  (`req.user`) is loaded — otherwise dev boot fails with TS2339.
- `validate()` writes the Zod-parsed **body** back to `req.body`, so transforms (enum casing,
  `we`→`WE`) reach handlers. Query/params are not reassigned.
- Prisma JSON columns: pass `Prisma.DbNull` for absent values, not `null`.
- Firebase is lazy-initialized; the server boots without it and auth routes return
  `FIREBASE_NOT_CONFIGURED` until `FIREBASE_SERVICE_ACCOUNT` is set.

## Deploy

Multi-stage `deployment/Dockerfile`; stack in repo-root `deployment/` (proxy + prod/dev
compose + `.env.backend` template); CI in `.github/workflows/backend-*.yml` (build & push to
Docker Hub). Runbook: `deployment/README.md`. Image not built locally (no Docker here) — CI
builds on push to `main`.

## Still pending (needs provisioning, not code)

- Firebase project → then wire the frontend portal login to `POST /api/auth/login` and feed
  the JWT to the admin dashboard (currently the dashboard accepts a pasted token; the portal
  still gates on client-side `apps/web/src/lib/auth.ts`).
- DO Spaces bucket → enables the panel-photo upload endpoint (frontend photo step not yet added).
- Droplet + DNS + Docker Hub secrets → first deploy (see `deployment/README.md`), then
  uncomment the `/api/*` proxy in `netlify.toml`.
