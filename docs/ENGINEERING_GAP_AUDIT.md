# AirGuard engineering gap audit

This audit compares the repository as it exists on 2026-10-03 with the product brief's trust-to-investigation workflow. It describes implemented code paths, not intended architecture. It is not a claim of operational aviation capability.

## Working today

- `backend/app/ingestion/service.py` calls the OpenSky state endpoint, normalizes returned vectors, and records source/freshness status. It has no generated-flight fallback in the live path.
- `backend/app/detection/rules.py` contains deterministic kinematic checks for position jumps, duplicate addresses, vertical rate, ground/air state mismatch, and an optional NIC rule. The configured standard OpenSky state-vector response omits NIC, so that rule is unassessed for the current live feed ([OpenSky field list](https://openskynetwork.github.io/opensky-api/rest.html#all-state-vectors)).
- `backend/app/detection/service.py` evaluates incoming records, persists aircraft states, and creates alerts for threshold-crossing records.
- The detector writes an `AircraftAssessment` record alongside each persisted observation, including unalerted observations.
- The assessment's rule-coverage value records only how many of five implemented rule inputs were assessable; it is not evidence confidence. State, assessment and any triggered alert are committed together. Each ingested observation has a unique idempotency key so Redis redelivery after commit-before-ack does not duplicate evidence; DB failures propagate for retry/dead-letter handling. These guarantees still need a live Redis/Postgres failure exercise.
- The live status API reports source vectors, normalized inputs, and displayed aircraft separately. Normalized/enqueued counts are not represented as worker evaluations because the detection workers are separate processes.
- The API provides live aircraft, track history, detail, route lookup, trust history, alerts, health, configuration, replay, and session-report endpoints.
- `GET /api/v1/airspace/event-candidates` derives provisional multi-aircraft space-time groupings from recent real alerts and their stored aircraft observations. It returns alert IDs, aircraft, observed time range, linked-pair count and the requested link radius/time window; candidates require analyst review.
- `/api/v1/airspace/event-cases` implements a server-revalidated evidence snapshot, case lifecycle, analyst disposition and append-only review history/audit entries. The Threats screen exposes the case workflow; migration and API behavior still need live database verification.
- The frontend has airspace, threat, investigation, replay, analytics, health, and admin views, plus an explicit empty state when aircraft data is missing.
- The login screen now uses real sessions and real viewer registration; fabricated client identities and demo-token auth were removed.
- The Docker frontend routes API, health, and WebSocket traffic through same-origin Nginx locations, allowing TLS termination without mixed-content API requests. Container startup remains unverified in the current environment.

## Incomplete product workflow

- Assessments are persisted per observation, but model/data-quality provenance and deterministic rule evidence are not yet consistently versioned as a reproducible evidence package.
- Candidate discovery is query-derived and capped to the most recent 1,000 real alerts. There is not yet a relationship graph between cases, and case API/migration behavior requires live database verification.
- Aircraft alert acknowledgement is still a boolean; case disposition adds case-level decisions and notes, but analyst feedback is not yet used to evaluate detector quality.
- Source abstraction is incomplete. Ingestion and normalization are coupled to OpenSky, despite a `source` field in storage.
- Coverage is not measured against a stated observation area/time window. A global request does not establish complete global aircraft coverage.
- Playback is based on retained observations, but does not yet reconstruct assessment/evidence changes for every timestamp.

## Misleading or unsupported behavior to correct

- The autoencoder constructs a network object before loading weights, but marks itself unavailable and returns no score unless weights load. Live ML is disabled by default; weights and validation remain an open requirement before enabling it.
- Receiver geometry returns `unavailable`; OpenSky sensor identifiers are not used as receiver coordinates or as multilateration evidence.
- Database numeric columns retain zero for missing kinematics for schema compatibility. The record carries `observed_fields`, and the current frontend/rule gates use this metadata; every new consumer must preserve that gate.
- `backend/app/api/v1/endpoints.py` can use a recent alert to describe a newer aircraft state, even if that state has no matching assessment.
- Detection history is in memory per worker process. A single worker preserves aircraft-local order within each batch; scaling to multiple workers can divide one ICAO's history across processes until history moves to shared or partitioned durable state.
- Redis pending-message reclaim and dead-letter durability are being addressed in code, but need a live Redis outage/restart exercise before their recovery guarantees are established.
- Global state requests are quota-limited; the project defaults to 90-second polling with credentials and 900 seconds anonymously. This is not an all-aircraft census or second-by-second global stream.

## Runtime state observed

- The frontend production build succeeds. Its main JavaScript chunk is about 946 kB minified and triggers Vite's 500 kB advisory.
- No API, database, Redis, or frontend listener is present in the current workspace. The bundled Python interpreter can compile the source but lacks FastAPI, SQLAlchemy, Redis, asyncpg and the other backend runtime packages; API, migrations, stream recovery and live ingestion could not be exercised end to end.

## Priority sequence

1. Verify detector and event-candidate behavior with a live Postgres/Redis runtime and real feed observations.
2. Add versioned rule/model provenance and persist complete reproducible evidence for every assessment.
3. Connect aircraft-level investigation and replay views directly to event-case evidence and show `INSUFFICIENT EVIDENCE` when inputs do not justify a score.
4. Add source adapters and measured coverage/health before adding more data providers or claiming global completeness.
