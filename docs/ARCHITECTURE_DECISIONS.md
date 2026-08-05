# Architecture Decision Records (ADR) Log

This document records the architectural decisions made for the AirGuard real-time ADS-B trust-scoring ground station project.

## Status Legend
- **Proposed**: Under review and pending approval.
- **Accepted**: Approved for implementation.
- **Superceded**: Replaced by a newer decision.

---

## ADR 001: Ingestion Scoping - Software Defined Radio (SDR) vs. OpenSky Network API

### Status
Accepted

### Date
2026-08-04

### Context
To evaluate the integrity of aircraft telemetry and compute real-time trust scores, AirGuard requires access to ADS-B transponder messages. We evaluated two primary ingestion methods:
1. **OpenSky Network API**: A crowdsourced aggregator that provides REST and WebSockets feeds of global aircraft states.
2. **Local SDR Receivers (e.g., RTL-SDR + dump1090)**: Deploying local physical receiver nodes to capture raw RF packets directly over the air at 1090 MHz.

### Decision
We implemented a **Hybrid Ingestion Layer** where the system connects directly to local dump1090 UDP/TCP sockets for raw Mode S frames, and falls back to a scheduled OpenSky API poller. A circuit breaker monitors client failures: if the remote API exceeds 3 consecutive request errors, it trips open for 60 seconds to safeguard system threads.

### Consequences
- **Pros**: Low latency ingestion, high signal resolution (extracting RSSI, signal strength), and robust fallback routines if OpenSky is offline.
- **Cons**: Elevates database sync complexity when mapping multiple receiver telemetry data points.

---

## ADR 002: Multi-layered Security Detection Model Scoping

### Status
Accepted

### Date
2026-08-04

### Context
ADS-B security requires low latency classification across heuristic rule violations (jump, duplicate, climb, mismatch) and multivariate behavioral changes.

### Decision
We implemented a **Three-layer Combined Detection Pipeline**:
1. **Deterministic Rule Checks**: Low-latency, physical limit triggers evaluating climb boundaries (±50m/s), duplicate locations, state mismatch, and speed deltas.
2. **Supervised ML Ensemble**: A soft-voting combination of RandomForest and Gradient Boosting models, mapping parameters to risk probability. Explainability is generated via SHAP TreeExplainer on the RF estimator.
3. **Unsupervised Autoencoder (Deep Learning)**: A PyTorch 5-layer autoencoder model checking reconstruction MSE (threshold=0.05) to flag unseen anomalies.

The outputs are aggregated into a **Combined Risk Score** (0.5 Rules + 0.3 Ensemble + 0.2 Autoencoder). Scores above `0.7` log a security alert.

### Consequences
- **Pros**: Cross-layer redundancy (rules capture spikes, autoencoder captures subtle multivariate drift), explainability via SHAP.
- **Cons**: High CPU overhead during multi-model evaluations (mitigated by asynchronous background tasks).

---

## ADR 003: Queue Decoupling & REST Rate Limiting

### Status
Accepted

### Date
2026-08-04

### Context
Processing ADS-B updates synchronously on REST endpoints blocking requests would lead to connection failures.

### Decision
Ingestion is decoupled from the detection pipeline using an in-memory asynchronous queue (`asyncio.Queue`). FastAPI REST endpoints (`/api/v1/inject`) and pollers push telemetry to the queue immediately and return. A background lifespan task runs the consumer loop concurrently. All REST endpoints are rate-limited via `slowapi` to prevent DoS attacks.

### Consequences
- **Pros**: Non-blocking requests, scale resilience, protected server resources.
- **Cons**: Telemetry audits lag slightly if the queue grows (monitored by the `/system-health` depth check).

---

## ADR 004: Frontend Dashboard & Accessibility Architecture

### Status
Accepted

### Date
2026-08-04

### Context
Visualizing 500+ tracks dynamically on a 3D Earth space requires performant frontends that remain accessible to keyboard-only and colorblind users.

### Decision
We selected:
- **Resium/CesiumJS**: WebGL 3D globe rendering.
- **React-Window**: List virtualization for the tracking sidebar to guarantee smooth 60fps scrolling under load.
- **Zustand**: Fast state management with WebSocket auto-reconnect and exponential backoff.
- **Accessibility Suite**: Added `role="button"`, focus styles, and screen reader labels. Badge statuses append visual indicators (`▲ [CRIT]`, `◆ [WARN]`, `● [OK]`) alongside color definitions.

### Consequences
- **Pros**: 60fps rendering, screen-reader compliant, colorblind-friendly.
- **Cons**: Large Cesium bundle sizes (mitigated by serving assets locally via Docker Nginx).
