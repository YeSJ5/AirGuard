# AirGuard final infrastructure and real-data verification

**Checked:** 2026-10-04  
**Scope:** current workspace and this machine; this is an evidence report, not a claim that AirGuard is operational as a complete live service.

## Result

AirGuard completed a genuine anonymous OpenSky global poll and normalized and persisted real provider records to PostgreSQL. The latest clean pass received **5,951 vectors**, normalized **5,891 real records** to the Redis stream, and inserted **zero synthetic records**. The detection worker consumed the stream and persisted assessments; database inspection confirmed provider provenance, assessment rows, and real rule evidence. This verifies the live path through Redis Pub/Sub and the API, but not delivery into an authenticated React session.

Redis is now operational on this machine using the WinGet-installed community Windows Redis build. The real OpenSky → Redis Stream → detection worker → PostgreSQL assessment path completed, and the API received genuine Redis Pub/Sub events. Redis outage/recovery and an isolated consumer reclaim/ack test also passed. The remaining end-to-end gap is the authenticated browser: the app is on its login page, so WebSocket delivery into React has not yet been verified. OpenSky OAuth is absent; anonymous access works within the provider's lower quota.

Status meanings: **PASS** means the stated scope has direct evidence; **BLOCKED** means a required external service or credential is unavailable; **NOT VERIFIED** means available checks do not prove the requested runtime behavior; **FAIL** means a configured check returned a failure.

## Installed dependency versions

Versions reported by the active backend virtual environment on 2026-10-04:

| Package | Installed version |
|---|---:|
| Python | 3.12.14 |
| NumPy | 1.26.4 |
| SHAP | 0.45.1 |
| PyTorch | 2.14.1 |
| scikit-learn | 1.6.0 |
| pandas | 3.0.6 |
| SciPy | 1.13.1 |
| SQLAlchemy | 2.0.54 |
| asyncpg | 0.29.0 |
| redis-py | 5.3.1 |
| FastAPI | 0.111.1 |
| Pydantic | 2.13.5 |

## Required component status summary

| Component | Status | Evidence / blocker |
|---|---|---|
| Python environment and dependencies | PASS | Python 3.12.14; installed versions above; `pip check` clean. |
| NumPy / SHAP compatibility | PASS | NumPy 1.26.4 and SHAP 0.45.1 import and compatibility checks passed. |
| Backend imports and compile | PASS | Required backend modules imported; `compileall` passed. |
| Backend unit tests | PASS | Latest full suite: see verification matrix below. |
| Backend integration tests | PASS | PostgreSQL CRUD and retention verified in a rollback-only isolated schema. |
| ML inference | PASS at test scope | Ensemble and autoencoder tests passed; not real-world accuracy evidence. |
| SHAP / autoencoder / rule engine | PASS at test scope | Unit checks passed; real-provider rule assessments were also persisted, while ML remains disabled unless explicitly configured. |
| Trust calculation | NOT VERIFIED as a calibrated score | Intentionally unscored when required evidence is unavailable; test-level behavior passed. |
| Evidence engine | PASS | Genuine provider states, assessments and a real rule-evidence row were persisted by the Redis worker. |
| PostgreSQL | PASS | PostgreSQL 18.4 connectivity and isolated integration operations passed. |
| Alembic | PASS with reconciliation caveat | Existing schema reconciled to head; clean-database full replay not run. |
| Redis / Streams / Pub/Sub | PASS through API | Redis 8.10.1 on loopback; real feed stream consumed and acknowledged; actual worker events observed through Pub/Sub at the API. Authenticated browser delivery remains unverified. |
| OpenSky adapter | PASS | Adapter and normalization tests passed; anonymous provider access returned HTTP 200. OAuth variables are absent. |
| Real ingestion | PASS for observed global polls | Latest clean run: 5,951 raw vectors; 5,891 normalized to `opensky_live`; zero synthetic inserts. Provider quota and coverage limits apply. |
| Detection pipeline | PASS through PostgreSQL | The real Redis worker consumed and acknowledged the stream; linked rules-v2 assessments persisted. |
| Evidence and trust persistence | PARTIAL | Genuine states and detector assessments were found in PostgreSQL; trust remains intentionally unscored when required evidence is missing. |
| Correlation | PASS at test scope | Unit behavior covered; no naturally occurring live event observed. |
| Event persistence | PASS at test scope | Transactional persistence exercised; live source-to-UI event flow not run. |
| WebSocket | PARTIAL | API Redis Pub/Sub listener received genuine worker updates; authenticated WebSocket-to-browser delivery and browser reconnect await a manual sign-in. |
| Frontend API / WebSocket integration | PARTIAL | Health shows backend, database and Redis connected on the login screen; authenticated flight retrieval and live updates remain unverified. |
| Frontend build / tests | PASS / PARTIAL | Production build, lint, and 5/5 motion checks passed; no general frontend test script is configured. |
| Authentication / RBAC / audit logs | PASS at test scope | Auth and role-protected endpoint tests passed; no full browser session. |
| System health | PASS for dependency reporting | API reported PostgreSQL and Redis connected, and upstream live after recovery. |
| Retention | PASS | PostgreSQL retention dry-run and actual deletion passed in rolled-back isolated schema. |
| Failure recovery | PASS for Redis | Redis stop/restart recovered its RDB state; API Redis health recovered, and the worker group retained lag 0 / pending 0. Browser WebSocket reconnect remains unverified. |
| Production data isolation | PASS by code-path review; live proof NOT VERIFIED | No simulation fallback is counted as live production data. |

## Security check

A filename-only scan of repository text files found no private-key markers or credential-like assignments matching the checked patterns. OpenSky credential environment variables were absent. Authentication, token validation, role checks, and audit-log behavior passed their automated test scope. This scan is not a substitute for a managed secret scanner or credential-provider audit.

## Verification matrix

| Requirement | Status | Evidence and limits |
|---|---|---|
| Python runtime | PASS | Workspace Python 3.12.14 was used for backend checks. |
| Dependencies | PASS | `pip check` reported no broken requirements in the backend environment. |
| NumPy / SHAP compatibility | PASS | NumPy 1.26.4 and SHAP 0.45.1 import and compatibility checks passed. |
| Backend imports | PASS | Twelve backend API, database, ingestion, and detection modules imported successfully. |
| Backend compile check | PASS | `compileall` passed. |
| Backend full suite (unit + database integration + contract) | PASS | `pytest -q`: **88 passed**, 2 upstream deprecation warnings, 95.65s. After a cleanup-only hardening change to the new Redis test, that integration test was rerun and passed **1/1**. The pass also covers fixing explicit detector rule configuration being overwritten by mutable global settings and returning HTTP 422 for unrepresentable timezone offsets. |
| Complete Schemathesis contract suite | PASS | `pytest tests/test_contract.py -vv --tb=short`: all 29 API operation contracts passed in 71.31s. One Starlette `PendingDeprecationWarning` recommends importing `python_multipart`; it did not fail a contract. Redis cache/stream and provider enrichment dependencies are isolated by the contract fixture; live service behavior is assessed separately below. |
| PostgreSQL service and connection | PASS | PostgreSQL 18 service is running; SQLAlchemy connectivity and a PostgreSQL query were verified. Database credentials are not included here. |
| Alembic state | PASS, with reconciliation caveat | `alembic current` reports `d4a8b6c913ef (head)`. The existing physical schema was inspected; two missing performance indexes were created, then the already-present schema was reconciled to the verified head. This was not a clean-database replay of every migration. |
| PostgreSQL integration operations | PASS, isolated | Live CRUD/relationship and retention tests ran against PostgreSQL 18 in a uniquely named schema within an outer transaction. The tests verified persisted rows and actual retention deletion, then rolled back; a follow-up query found zero leftover test schemas. The tests no longer drop or recreate application tables. |
| Redis service | PASS | Redis 8.10.1 community Windows build installed by WinGet; bound to `127.0.0.1:6379`, protected mode enabled; RDB state reloaded after recovery. |
| Redis Streams / consumer groups / acknowledgement / retry | PASS | Production stream `airguard:telemetry`: 11,777 entries read, consumer lag 0, pending 0. Isolated test passed XADD, XREADGROUP, XAUTOCLAIM and XACK; its unique test stream was deleted. |
| Redis Pub/Sub / distributed fan-out | PASS to API | Passive subscriber received an actual worker-generated batch with 200 records (`opensky_live`, `is_synthetic=false`); the API listener received worker updates. Browser WebSocket delivery remains pending login. |
| OpenSky credentials | OPTIONAL / ABSENT | Credentials are not configured; anonymous access succeeded once under lower provider quotas. |
| Genuine OpenSky ingestion | PASS for observed run | Latest poll: 5,951 vectors received; 5,891 normalized to the real Redis stream; this is not an all-aircraft guarantee. |
| Normalization | PASS | Parser tests passed and genuine feed records were normalized with source provenance. |
| Detection and evidence | PASS for observed run | Worker processed the genuine stream; a real non-synthetic rules-v2 assessment and a real rule-based review alert/evidence row were inspected in PostgreSQL. The detector flag is a review lead, not proof of malicious activity. |
| Trust score | NOT VERIFIED / intentionally unscored | The backend leaves trust score unavailable. Current rule output is an uncalibrated detector-risk triage signal, not an aircraft-authenticity probability or safety rating. |
| Database persistence of real telemetry | PASS for observed run | SQL inspection confirmed authentic provider rows with `is_synthetic=false` and linked detector assessment rows. |
| Correlation logic | PASS at test level | Unit-level behavior is covered; no naturally occurring live multi-aircraft event was observed. |
| Event case persistence | PASS at test level; live flow NOT VERIFIED | ORM relationships and case/review persistence were exercised transactionally; live API-to-database-to-frontend case flow was not run. |
| WebSocket delivery | PARTIAL | API Redis Pub/Sub listener received genuine messages; an authenticated browser WebSocket has not yet been tested. |
| Frontend API connection / aircraft retrieval | PARTIAL | Frontend dev server and API health were reachable; aircraft API correctly requires authentication. No live authenticated browser session was exercised. |
| Frontend WebSocket updates / reconnect | NOT VERIFIED | The login page is still visible; no authenticated React session or browser reconnect has been exercised. |
| Frontend aircraft, trust, threats, investigation views | NOT VERIFIED at live-data scope | Components build and filter non-live/simulation records from production selectors, but were not exercised in an authenticated browser with genuine provider observations. |
| Authentication / RBAC | PASS at unit/contract scope | Auth and role-protected endpoint tests passed; no full browser-to-live-backend session was verified. |
| Audit logs | PASS at test scope | Unit/API coverage passed; no real operator session was run end to end. |
| System health | PASS for honest dependency reporting | Live API reports PostgreSQL and Redis connected and the successful upstream state; during Redis stop it reported Redis disconnected, then recovered after restart. |
| Failure and recovery | PASS for Redis | Redis stopped and restarted; RDB restored the stream/group, API health returned connected, lag stayed 0, pending stayed 0, and the worker remained active. Browser WebSocket reconnect remains unverified. |
| Production data isolation | PASS by code-path review; live proof NOT VERIFIED | Live ingestion marks provider rows as non-synthetic and frontend selectors exclude simulation/fallback rows. No fake aircraft were used to represent live coverage. |
| Frontend build and type check | PASS | Latest `npm run build` passed: 857 modules; JS 953.20 kB (265.61 kB gzip), CSS 98.19 kB (21.75 kB gzip). Vite reports the existing >500 kB chunk advisory. |
| Aircraft motion checks | PASS | Existing `npm run test:motion` passed 5/5 checks. These are deterministic client-motion checks, not live-data evidence. |
| Frontend lint | PASS | Latest `npm run lint` passed with zero errors and zero warnings after adding explicit API response types and correcting effect dependencies. |
| `git diff --check` | PASS | No whitespace errors; Git emitted line-ending conversion notices for modified files. |
| Competitor terminology audit | PASS | Repository source and product documentation contain no competitor-specific product-name references. |

## Current operational limits

- **Authenticated browser verification remains outstanding.** The existing login flow is intact, and sign-in must be completed manually before map/API/WebSocket updates can be checked in React.
- OpenSky anonymous access is subject to lower provider quotas. Global coverage is provider-limited and is not a complete census of aircraft.
- The frontend bundle-size advisory remains open. Build success does not clear that performance opportunity.
- AirGuard is an airspace awareness and telemetry-investigation prototype. OpenSky state-vector data does not provide raw radio reception, receiver geometry, or certified aircraft trust.

## Next evidence needed

1. Sign in through the open AirGuard login page with the existing account; then verify the aircraft API and live WebSocket update in the authenticated React browser.
2. With an authenticated session, exercise browser WebSocket disconnect/reconnect and record the recovered live state.
3. Decide whether the large frontend bundle warrants code splitting after browser verification.

## Final Redis and End-to-End Verification

**Checked:** 2026-10-04. This section supersedes the earlier Redis-blocked status entries above; those entries are retained as the history of the first verification attempt. The authenticated React browser portion remains pending manual sign-in.

| Check | Result | Direct evidence |
|---|---|---|
| Redis version and endpoint | PASS | Redis **8.10.1**, `redis://127.0.0.1:6379/0`, database 0, no password configured. Server bound to `127.0.0.1` with protected mode enabled. The installed artifact is a community Windows port, [WinGet package and release](https://github.com/taizod1024/redis-windows/releases/tag/8.10.1); WinGet verified the manifest SHA-256. |
| Startup and persistence | PASS for this workstation session | Portable WinGet package launched in a foreground process with RDB snapshots in `F:\major_project\.tmp\airguard-redis`. This is a manually running local process, not an installed Windows service. Redis successfully saved and reloaded its RDB after the recovery test. |
| Redis connectivity | PASS | `redis-cli PING` returned `PONG`; the API system-health endpoint reported Redis and PostgreSQL connected. |
| Isolated Streams semantics | PASS | `backend/tests/test_redis_integration.py` used a unique `airguard:test:redis-verification:*` key with a non-aircraft probe and verified XADD, XREADGROUP, pending state, XAUTOCLAIM, XACK, and cleanup. **1 test passed**; the production stream was untouched by this probe. |
| Production stream and group | PASS | `airguard:telemetry`, group `detection-group`; **11,777 real entries read**, consumer lag **0**, pending **0**, one active consumer after restart. The count is the two observed polls combined (5,886 + 5,891). |
| Real OpenSky → Redis | PASS | Latest poll returned **5,951 raw vectors**, normalized **5,891** valid records to the stream. Inspected stream payloads showed `source=opensky_live` and `metadata.is_synthetic=false`. No test aircraft or fabricated production events were written. |
| Detection worker and duplicate handling | PASS for observed stream | Standalone `python -m app.worker` consumed the production stream. All 11,777 group entries were acknowledged; no pending entries or lag remained. A 10-minute PostgreSQL query found 5,598 recent real state rows, 5,598 distinct ingestion IDs, and 5,598 linked assessments. The database enforces uniqueness on ingestion IDs and the worker skips already-persisted deliveries. |
| State and assessment trace | PASS | One inspected real state: PostgreSQL row 22541, ingestion ID `eee18e78-156f-4781-90c0-5ac7ae347298`, ICAO `39de4f`, callsign `TVF99PC`, source `opensky_live`, `is_synthetic=false`, received `2026-10-04T05:37:55Z`; linked rules-v2 assessment at `05:38:36Z` is `INSUFFICIENT_EVIDENCE`, risk 0.0, coverage 0.4. Trust remains unavailable; the UI must preserve the insufficient-evidence status. |
| Real rule evidence | PASS | A separate real, non-synthetic OpenSky alert row was joined to its source state and assessment: rules-v2 `REVIEW_REQUIRED`, rule `rule_alt_vel_mismatch`, coverage 0.2. It is a heuristic review lead, not proof of malicious behavior or a safety verdict. |
| Worker → Redis Pub/Sub → API | PASS | A passive subscriber captured a naturally generated `AIRCRAFT_BATCH_UPDATE` published by the worker: 200 items, with an inspected record carrying `source=opensky_live` and `is_synthetic=false`. API logs also showed worker-generated aircraft batches and alert messages arriving on `airguard:websocket_channel`. The subscriber never published an event. |
| Redis failure/recovery | PASS for API and worker | With stream lag 0 and pending 0, Redis was stopped. API health reported Redis disconnected while PostgreSQL stayed connected. Redis restarted, loaded two RDB keys, PING returned PONG, the API returned to Redis connected, and the `detection-group` position/ack state was preserved at lag 0 and pending 0. |
| Browser login and React WebSocket | NOT VERIFIED | The browser visibly remains on the AirGuard login page, which reports backend, database, and Redis connected. The aircraft endpoint correctly returned 401 without a session. The computer-use skill forbids entering authentication credentials, so the account owner must sign in manually before browser aircraft rendering, authenticated WebSocket delivery, or browser reconnect can be verified. |
| Final code checks | PASS | Full backend suite **88 passed** (including the isolated Redis test); its updated cleanup guard then passed a targeted **1/1** rerun. The suite includes all **29 API contract cases**. Frontend build passed (857 modules), lint passed with zero warnings, and motion checks passed **5/5**. |

**Status:** Real OpenSky → Redis Streams → detection worker → PostgreSQL → Redis Pub/Sub → API listener is verified. Do not label the whole system “fully connected / end-to-end verified” until an authenticated browser receives real aircraft and WebSocket updates and browser reconnect is exercised.
