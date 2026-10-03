# AirGuard viva preparation

## Project in one sentence

AirGuard is an airspace awareness and signal-quality learning platform that displays aircraft reports with source and freshness context, and helps users review unusual telemetry without presenting an unverified report as ground truth.

## Problem and distinction

ADS-B state vectors are useful reports, but a report alone does not establish identity, position authenticity, airworthiness or safety. A general-purpose map can show movement; AirGuard's project contribution is to pair movement with provenance, freshness, explainable review flags, replay and public-facing education. The current implementation is a project prototype, not an operational surveillance or air traffic control system.

## Current data flow

1. The backend polls the OpenSky global state feed at a quota-aware interval.
2. Incoming state vectors are normalized and stored/streamed through the application pipeline.
3. Rule checks and available detector models can produce review alerts.
4. The API exposes tracks, health, alerts, route/identity enrichment when available, and historical playback data to the React interface.
5. When the provider is rate-limited or unavailable, AirGuard shows no aircraft and reports the feed condition. It does not synthesize substitute tracks.

Provider receiver coverage, API quotas, stale reports and aircraft transmission behaviour limit what the system can display. It cannot promise every aircraft or complete global coverage.

## What is measured and what is inferred

- Position, altitude, speed, heading, report time and source are fields received in a state vector; their truth is not independently established by receipt.
- Route, operator and airframe details may be enriched from separate sources and can be missing or estimated.
- A review flag is a detector result. It is not a confirmed spoofing incident.
- Missing alerts do not establish that a track is authentic or safe.
- Raw RSSI and receiver-based multilateration require actual receiver observations.
- A derived detector score is not a probability of aircraft safety.

## Why the project is useful

AirGuard gives learners an accessible way to explore aircraft reports and gives researchers a place to inspect unusual movement and reproduce detector experiments. For monitoring teams, the longer-term value is reviewable evidence and measured data coverage, subject to validated sources and operational governance.

## Current limitations and next work

- **Coverage:** the configured feed and its area/quotas bound visibility. Add source adapters, region tiling where permitted, caching, and measured freshness/coverage reporting.
- **Receiver evidence:** no physical, time-synchronized receiver mesh is configured in this project. Integrate calibrated receivers before claiming multilateration.
- **Metadata and route:** enrichment can be incomplete. Show source and confidence and retain unknown values instead of inventing them.
- **Detection evaluation:** benchmarks need versioned, labeled datasets, class balance, reproducible settings, and independent validation before operational accuracy claims.
- **Operations:** a real deployment needs durable audit history, access policy, retention, monitoring, provider agreements and operator procedures.

## Likely examiner questions

**Why not show every aircraft?**  
The application requests the provider's global state feed and shows only real received reports. Global visibility is limited by the provider's receiver network, transmission availability, and account quota; AirGuard does not claim complete coverage or generate substitute aircraft.

**Does a green/no-alert status mean a flight is safe?**  
No. It only means that no active review flag is recorded for that report. ADS-B reports are not independently authenticated by this application.

**How is a spoofing alert confirmed?**  
The current prototype flags patterns returned by configured rules/models. A real confirmation needs independent evidence such as calibrated multi-receiver timing, trusted sensor fusion, or operator investigation. A detector alert by itself is a lead, not proof.

**What makes this different from a flight map?**  
It combines track exploration with data-source/freshness context, explainable review flags, replay and learning content. Its product claim is evidence-aware interpretation rather than a promise of exhaustive coverage.

**What would make the results scientifically credible?**  
Version the code and thresholds, publish dataset construction and class balance, use separate training and evaluation data, test false positives across normal operational conditions, compare baselines, and report uncertainty and limitations.

## Suggested closing

AirGuard makes observed aircraft reports more understandable and reviewable. Its next research step is to connect provenance and coverage to real receiver evidence and evaluate the detectors on independently labeled data. Missing evidence remains unknown, and provider coverage is not complete surveillance.
