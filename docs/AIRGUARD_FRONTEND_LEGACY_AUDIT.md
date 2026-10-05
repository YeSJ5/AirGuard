# AirGuard frontend legacy audit

**Scope:** `frontend/src`, `frontend/public`, and `frontend/index.html`. The audit and cleanup preserve the current authenticated product shell and backend/API contracts.

## Findings

- The frontend has **no URL route declarations**, React Router setup, redirects, route-level lazy imports, or service worker. Its navigation is a single authenticated React shell with internal view state.
- Authenticated destinations inspected: overview, airspace, threats/alerts, investigation drawer, analytics, replay, system configuration, admin, and product guide. Login is the unauthenticated entry view. Admin is role-gated.
- Four orphaned legacy screens/shells were present: the standalone `Header`, `MapContainer`, `ThreatCenterView`, and `InvestigationView`. They were not imported by the app entry point, but contained older navigation state, terminology, layouts, and duplicated aircraft/threat interfaces.
- Ten orphaned support components belonged only to those branches: `Badge`, `EmptyState`, `Icons`, `AircraftIdentityCard`, `DetectionPipelineTiers`, `EvidenceChecklist`, `SHAPEvidencePanel`, `TrustHistoryChart`, `TrustScoreHero`, and `ThreatCard`.
- The unused Vite starter stylesheet and five unreferenced starter assets were also present.
- No FlightRadar24 reference, PWA/service-worker registration, mock aircraft injection, or fake production threat-generation control is present in the frontend source. Synthetic/source fallback filtering remains intentionally in place as data-integrity protection.

## Changes

- Removed the 14 unreachable legacy screens and support components listed above. The active map, recorded playback, event review, shared shell, API calls, and data filtering remain in use.
- Removed the unused starter stylesheet and starter visuals (`hero.png`, `react.svg`, `vite.svg`, `icons.svg`).
- Removed stale CDN script/style and font preconnects from the HTML entry: Leaflet is already imported as a bundled dependency (including its stylesheet), and the app uses a system font stack.
- Replaced visible prototype language such as “WATCH RADAR”, “Tier 2”, “Tier 3 Deep Technical Suite”, “Flight Guide”, and “Ground Station Receiver” with AirGuard workspace terminology.
- Removed user-facing showcase/cinematic camera controls and replay-intro affordances. No generated position or threat data was added.
- Corrected the browser title and added current-product description/Open Graph metadata. Updated the OpenSky wording to “state-vector” coverage.

## Route and navigation inventory

There are **zero explicit URL routes** in this repository, so there are no route components, route redirects, direct-route refresh handlers, or route-specific lazy chunks to patch. The only URL entry is the Vite-served app document. Authenticated destinations share the same application header, primary navigation, footer, and shell; tab changes switch the rendered workspace in place. Aircraft and event investigation open within that shell.

Source-level navigation audit: every primary nav and workspace tab in `App.tsx` maps to one of those current state destinations. Alerts and event candidates open the current investigation drawer. Logout clears the authenticated session and returns to the login view. There is no separate legacy page for browser back/forward or a nested URL to reach.

## Legacy audit totals

| Measure | Result |
| --- | ---: |
| Explicit URL routes inspected | 0 |
| Authenticated view destinations inspected | 9 |
| Legacy screens/shells found / removed | 4 / 4 |
| Legacy support components found / removed | 10 / 10 |
| Legacy redirects fixed | 0 |
| Legacy visible strings replaced | 16 title/label/copy locations |
| Duplicate layouts removed | 1 obsolete standalone shell, plus its obsolete map layout |
| Showcase/cinematic controls removed | 3 settings locations plus the replay-intro affordance |
| Demo-only UI removed | 1 dormant presentation feature from 3 UI locations |
| Mock production aircraft/threat data found / removed | 0 / 0 |
| Service-worker/cache mechanisms found | 0 |

## Verification status

- Browser title and product metadata now identify **AirGuard — Airspace Trust & Threat Intelligence**.
- Static source audit found no old standalone-screen imports from the app entry point and no explicit route library/configuration.
- Authenticated browser traversal was completed in the available local session: Airspace, Threats, Investigate, Analytics, Replay, System, Product guide, and Overview all remained inside the current AirGuard shell. The empty-feed Investigate action returned to the current airspace target list. Refresh returned to the current Overview shell.
- Admin navigation was not visible to the current account; aircraft-row and per-aircraft investigation checks were not possible with zero live aircraft. Tablet/mobile layout could not be inspected because the active in-app browser does not expose viewport resizing.
- The browser title matched the current product identity. No UI exception was observed, but browser logs show expected API `Failed to fetch` errors because the backend at the configured local API endpoint was disconnected during this audit. The screen reported zero aircraft and did not fabricate records.
- `npm run build`: passed (TypeScript + Vite, 857 modules). Vite reports the existing Cesium-heavy JavaScript chunk at about 950 kB and emits its >500 kB advisory.
- `npm run lint`: passed with zero warnings.
- The authenticated navigation paths visible to the current account were click-verified: 8/8. Admin and aircraft-specific actions were role/data-gated and could not be traversed in this empty-feed session.
- Backend/API files were not changed in this cleanup. The backend suite had passed in the immediately preceding verification pass (88 tests); it was not rerun because this change only touched frontend files and documentation.

## Remaining limitation

The app uses internal view state rather than URL routes. Refreshing retains the latest application shell but returns to its default overview state; browser history does not represent workspace-tab changes. No legacy UI is reachable through the current app navigation, but deep links and per-workspace browser history are not implemented. Full data-backed click-through also depends on the API being available; it was disconnected during this pass.
