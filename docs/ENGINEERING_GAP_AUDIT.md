# AirGuard engineering gap audit

This audit compares the repository as it exists on 2026-10-03 with the product brief's trust-to-investigation workflow. It describes implemented code paths, not intended architecture. It is not a claim of operational aviation capability.

## Working today

- `backend/app/ingestion/service.py` calls the OpenSky state endpoint, normalizes returned vectors, and records source/freshness status. It has no generated-flight fallback in the live path.
- `backend/app/detection/rules.py` contains deterministic kinematic checks for position jumps, duplicate addresses, vertical rate, ground/air state mismatch, and optional NIC evidence.
- `backend/app/detection/service.py` evaluates incoming records, persists aircraft states, and creates alerts for threshold-crossing records.
- The API provides live aircraft, track history, detail, route lookup, trust history, alerts, health, configuration, replay, and session-report endpoints.
- The frontend has airspace, threat, investigation, replay, analytics, health, and admin views, plus an explicit empty state when aircraft data is missing.
- The login screen now uses real sessions and real viewer registration; fabricated client identities and demo-token auth were removed.

## Incomplete product workflow

- Every observation does not yet have a durable assessment record. Scores are primarily stored when an alert is created, so non-alert observations cannot form a complete trust history.
- There is no persisted cross-aircraft event model, event lifecycle, event relationship graph, or spatial-temporal cluster engine.
- Alert acknowledgement is not a full analyst disposition workflow: it lacks a decision category, reason, notes, and a reproducible feedback record.
- Source abstraction is incomplete. Ingestion and normalization are coupled to OpenSky, despite a `source` field in storage.
- Coverage is not measured against a stated observation area/time window. A global request does not establish complete global aircraft coverage.
- Playback is based on retained observations, but does not yet reconstruct assessment/evidence changes for every timestamp.

## Misleading or unsupported behavior to correct

- `backend/app/detection/autoencoder.py` contains hard-coded airport/city coordinates presented as ground receivers. Those are not a receiver network and cannot support multilateration.
- When fewer than two receiver IDs are supplied, the geometry function returns a perfect consistency score. Missing receiver evidence must be `UNAVAILABLE`, not a passing result.
- The ensemble has a rule-derived fallback probability when its model is unavailable. That is the same evidence counted again under an ML label.
- The autoencoder silently runs with random weights if loading fails. Its live score then has no trained-model basis.
- The detector invents cold-start variance values before enough observations exist, and fills missing OpenSky kinematics with zero. Both can create unsupported model inputs and conclusions.
- The live risk formula assigns fixed weights to ML and receiver scores even when those sources are unavailable or unvalidated for the actual polling cadence.
- `backend/app/api/v1/endpoints.py` can use a recent alert to describe a newer aircraft state, even if that state has no matching assessment.
- `docker/docker-compose.yml` enables in-process detection by default while also starting Redis-stream workers, allowing the same observation to be evaluated more than once. Two workers also split aircraft history across independent in-memory histories.
- The UI calls tier 4 “Multilateration Geometry” even though actual synchronized receiver observations are not available.

## Runtime state observed

- Vite serves the frontend at `http://localhost:5173`.
- The API is not listening on port 8001. This machine has no usable Python runtime with the backend dependencies installed, so API, database migrations, and live ingestion could not be exercised end to end.
- The production frontend build succeeds. Its main JavaScript chunk is about 955 kB minified and triggers Vite's 500 kB advisory.

## Priority sequence

1. Make detector inputs and model/receiver availability explicit; never manufacture a pass score from missing evidence.
2. Ensure each real observation is processed once and in aircraft timestamp order.
3. Persist a versioned assessment for every observation, including evidence availability, quality, confidence, and model provenance.
4. Add time-and-space event formation over real assessments, with analyst disposition and audit history.
5. Connect aircraft, threat, investigation, event, and replay views to those persisted records; show `INSUFFICIENT EVIDENCE` when inputs do not justify a score.
6. Add source adapters and measured coverage/health before adding more data providers or claiming global completeness.
