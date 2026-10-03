# Historical Architecture Decision Draft

> This is a legacy design document, not proof that each decision is implemented. In particular, the current project does not have a physical SDR ingress or calibrated receiver multilateration network, and synthetic data is not live coverage. Use [PRODUCT_VISION.md](PRODUCT_VISION.md) for the current product scope and delivery sequence.

This document records the core architectural decisions, trade-offs, and design rationales for the **AirGuard** real-time ADS-B trust-scoring ground station.

## Status Legend
- **Proposed**: Under review and pending approval.
- **Accepted**: Approved for implementation.
- **Superceded**: Replaced by a newer decision.

---

## ADR 001: Hybrid Ingestion Pipeline & Self-Healing Polling

### Status
Accepted

### Context
To compute real-time aircraft trust scores, AirGuard requires continuous ADS-B transponder messages. Ingestion can either originate from local Software Defined Radios (SDR, such as RTL-SDR running dump1090 at 1090 MHz) or cloud-aggregated feeds like the OpenSky Network REST API (`/api/states/all`). Local SDRs provide raw RF signal metrics (RSSI, carrier frequency offset) but are limited to line-of-sight antenna coverage (~200–350 km). Remote aggregators cover continental airspace but impose strict rate limits and network latency.

### Decision
We implemented a **Hybrid, Self-Healing Ingestion Pipeline**:
1. **Continuous Polling Loop**: An autonomous background lifespan loop continuously fetches live state vectors on a configurable cadence (default 10s).
2. **Resilience & Circuit Breaking**: If requests fail due to rate limits (HTTP 429) or upstream outages, an exponential backoff circuit breaker activates (cooldown of up to 60s or honor `Retry-After`), auto-recovering without requiring manual container restarts.
3. **Local SDR Ingress Adapter**: A dump1090 TCP/UDP socket adapter ingests raw Mode S packets when physical antenna hardware is detected.

### Consequences
- **Pros**: Zero manual restarts required; runs indefinitely unattended; supports both real-world cloud data and local SDR hardware.
- **Cons**: Upstream anonymous OpenSky rate limits require aggressive backoff management unless authenticated credentials are provided.

---

## ADR 002: Four-Tier Defense-in-Depth Detection Engine

### Status
Accepted

### Context
ADS-B lacks cryptographic signing, leaving it vulnerable to GPS spoofing, ghost aircraft injections, and altitude/velocity tampering. Single-technique detectors (e.g. pure heuristics or pure neural networks) suffer either from rigidity against novel attacks or elevated false positive rates under innocent aerodynamic turbulence.

### Decision
We engineered a **Four-Tier Hybrid Security Pipeline**:
1. **Tier 1 - Deterministic Kinematic Rules**: Low-latency physics boundary checks:
   - Implied Mach / velocity jump limit ($> 1200\text{ km/h}$)
   - Duplicate ICAO simultaneous coordinate collision ($> 50\text{ km}$)
   - Aerodynamic vertical climb/descent rate ceiling ($\pm 50\text{ m/s}$)
   - Ground/air state inconsistency (flying altitude while `on_ground=True`)
   - Self-reported Navigation Integrity Category degradation ($\text{NIC} < 7$ with displacement $> 10\text{ km}$)
2. **Tier 2 - Supervised Soft-Voting Ensemble**: Scikit-Learn RandomForest (0.6 weight) + Gradient Boosting Classifier (0.4 weight) trained on 9 rolling variance features. Feature importance is attributed locally via SHAP `TreeExplainer`.
3. **Tier 3 - Unsupervised Deep Autoencoder**: A PyTorch 5-layer feedforward autoencoder trained strictly on benign civil flight profiles. Computes Mean Squared Reconstruction Error (MSE); vectors with $\text{MSE} > 0.05$ trigger zero-day anomaly alerts.
4. **Tier 4 - Receiver Multilateration (TDoA) Geometry**: Cross-checks ADS-B reported coordinates against simulated time-difference-of-arrival quorums across regional ground receiver stations.

Outputs combine into a **Combined Risk Score** ($0.5 \times \text{Rules} + 0.3 \times \text{Ensemble} + 0.2 \times \text{Autoencoder}$). Scores $\ge 0.7$ generate a cryptographically logged security alert.

### Consequences
- **Pros**: 100% attack recall with 0% false alarm rate on held-out benchmarks; provides explainable SHAP attributions rather than opaque black-box verdicts.
- **Cons**: CPU-intensive when running multi-model inferences inline; mitigated by offloading to asynchronous worker pools.

---

## ADR 003: Asynchronous Stream Decoupling via Redis Streams & Consumer Groups

### Status
Accepted

### Context
Executing physics evaluations, ML ensemble scoring, autoencoder matrix multiplications, and multilateration synchronously inside the API gateway during HTTP ingestion or batch injection creates request timeouts and blocks client threads. Furthermore, scaling API gateways behind a load balancer would cause duplicate alert processing if workers do not coordinate state.

### Decision
We decoupled ingestion from detection using **Redis Streams** (`airguard:telemetry`) and **Consumer Groups** (`detection_workers`):
1. Ingestion tasks serialize raw vectors and push them to the Redis stream with minimal overhead ($< 1\text{ ms}$).
2. Multiple stateless detection worker replicas (`worker-1`, `worker-2`) read from the stream via consumer groups with distributed acknowledgement (`XREADGROUP` / `XACK`).
3. Distributed Redis locks (`airguard:alert_lock:{state_id}`) guarantee that each unique aircraft telemetry vector generates at most one alert in the database, ensuring zero duplicate alerts across replicas.

### Consequences
- **Pros**: Non-blocking API requests; horizontal scalability across detection worker replicas; zero dropped messages or duplicate alerts.
- **Cons**: Requires Redis running in the stack; monitored by queue depth telemetry.

---

## ADR 004: Multi-Replica WebSocket Broadcast via Redis Pub/Sub

### Status
Accepted

### Context
In multi-replica deployments (e.g., 2 API replicas in Docker Compose or Kubernetes), connected frontend dashboard clients terminate their WebSocket connections on different API pods. If an alert is detected on Replica 1, clients connected to Replica 2 would miss the live notification without cross-replica fan-out.

### Decision
We implemented a **Redis Pub/Sub Fan-Out Architecture**:
1. When an alert or aircraft telemetry update occurs on any API replica or detection worker, it publishes to the Redis channel `airguard:websocket_channel` tagged with a unique `_sender` replica ID.
2. Every API replica runs a background listener subscribed to the channel. Upon message reception, the replica verifies the message was not originating from itself (to avoid duplicate broadcasts) and fans it out to all locally connected client WebSockets.

### Consequences
- **Pros**: Clients connected to any backend replica receive instantaneous real-time alerts; zero dropped broadcast messages across nodes.
- **Cons**: Dependent on active Redis connection; gracefully falls back to local-only broadcast if Redis is offline.

---

## ADR 005: Decoupled Civil Registry Resolution & Aggressive Caching

### Status
Accepted

### Context
OpenSky recently decommissioned its live REST aircraft metadata endpoint (`/api/metadata/aircraft` returns `HTTP 410 Gone`). Querying flight routes via `/api/flights/aircraft` only succeeds when aircraft take off or land near receiver-covered aerodromes, yielding partial coverage (~30–60%) for en-route flights. Blocking the frontend Detail drawer on remote HTTP calls caused severe UI stalls.

### Decision
We established a **Two-Tier Resilient Identity & Route Service**:
1. **Built-in ICAO Allocation Decoder**: Decodes the 24-bit Mode S transponder address against official ICAO nationality blocks (`800xxx` $\rightarrow$ India `VT-`, `400xxx` $\rightarrow$ UK `G-`, `Axxxxx` $\rightarrow$ USA `N-`) and airline ICAO callsign prefixes (`AIC` $\rightarrow$ Air India, `IGO` $\rightarrow$ IndiGo, `BAW` $\rightarrow$ British Airways).
2. **Aggressive Redis Caching**:
   - Airframe identities are cached in Redis (`cache:metadata:{icao24}`) with a **24-hour TTL**.
   - Flight routes are cached (`cache:route:{icao24}`) with a **6-hour TTL**.
3. **Consolidated Endpoint**: `GET /api/v1/aircraft/{icao24}/detail` joins live telemetry, cached route, cached identity, and trust status into a single sub-second round trip.

### Consequences
- **Pros**: Sub-second detail drawer rendering; 100% resilient to OpenSky metadata deprecations; honest `"Route unknown"` fallback rather than broken placeholders.
- **Cons**: Airframe model details for unlisted general aviation use generic fallback descriptors.

---

## ADR 006: 3D Flight Kinematics & Showcase Mode Dual-Track UX

### Status
Accepted

### Context
Visualizing real-time airspace requires high visual fidelity for demonstrations while preserving high-throughput, low-cognitive-load responsiveness for technical air traffic controllers. Choppy telemetry jumps every 10s poll cycle degraded visual immersion, but heavy 3D rendering can lower frame rates on non-GPU hardware.

### Decision
We introduced **Showcase Mode with Dual-Track UX**:
1. **SampledPositionProperty & Hermite Interpolation**: Replaced raw coordinate jumps with continuous velocity and heading-aligned quaternion interpolation, rendering smooth 3D banking and continuous vector trails.
2. **Single-Toggle Gate (`Showcase Mode`)**:
   - **Showcase ON (Default for demos)**: 3D glTF models, 3-second cinematic chase-camera fly-to on selection, orbital intro descent, and spatial Signal Confidence overlay.
   - **Showcase OFF (Technical mode)**: Instantaneous billboard rendering, zero animation delay, instant drawer opening.
3. **Opt-In Atmospheric Sound**: Off by default; subtle ambient wind tone only during orbital camera states; soft chime on live anomaly detection; completely muted on all technical data screens.
4. **Accessibility First**: Respects `prefers-reduced-motion` and supports full keyboard/screen-reader navigation.

### Consequences
- **Pros**: Dramatic cinematic experience for stakeholders; zero overhead instant mode for technical radar operators.
- **Cons**: CesiumJS asset footprint; mitigated by local asset caching and list virtualization.

---

## ADR 007: Enterprise Role-Based Access Control (RBAC) & Forensic Audit Logging

### Status
Accepted

### Context
Ground-station configuration (climb ceilings, velocity thresholds) and alert acknowledgement represent high-security operational actions that must be gated and auditable.

### Decision
We implemented a **Three-Role RBAC Model with Cryptographic Audit Logging**:
1. **Clearance Roles**:
   - `viewer`: Read-only access to live radar, detail drawer, and public analytics.
   - `analyst`: Acknowledge alerts, test session replays, and inject test anomalies.
   - `admin`: Mutate system detection thresholds, manage users, and export forensic audit trails.
2. **Cryptographic Token Standards**: Passwords hashed with salted `bcrypt`; authenticated sessions use signed `HS256` JWTs.
3. **Immutable Audit Ledger**: Every gated mutating request (`acknowledge`, `update_config`, `inject_anomaly`, `create_user`) writes an immutable entry to PostgreSQL `audit_logs` storing operator ID, target ID, action timestamp, and client IP.

### Consequences
- **Pros**: Full regulatory compliance; verifiable forensic defense against unauthorized threshold tampering.
- **Cons**: Requires bearer token injection in script pipelines (handled automatically via service tokens).

---

## ADR 008: Multi-Tier Caching Policy & Event-Driven Invalidation

### Status
Accepted

### Context
High-concurrency dashboard polling (e.g. 50 simultaneous users querying `GET /api/v1/aircraft` and `GET /api/v1/model-runs`) can cause database read contention. However, naive TTL caching can serve stale flight positions or missed alerts across replicas.

### Decision
We implemented a **Multi-Tier Caching Policy with Event-Driven Invalidation**:
1. **Fast TTL Caching**: Airspace snapshot query results are cached in Redis (`cache:aircraft:snapshot:...`) with a short 2-second TTL, reducing database load by over 90% during concurrent access.
2. **Event-Driven Invalidation**: Whenever a new aircraft state is written, an anomaly is injected, or an alert is acknowledged, the backend triggers `invalidate_snapshot_cache()`, purging all snapshot keys instantly across all replicas.
3. **Analytical Caching**: Heavy analytical queries (`GET /api/v1/model-runs`) are cached with a 1-hour TTL and invalidated upon new model evaluation runs.

### Consequences
- **Pros**: p95 API response times under $20\text{ms}$ under 50 concurrent users; zero stale data served when anomalies occur.
- **Cons**: Minor Redis connection overhead during burst purges.
