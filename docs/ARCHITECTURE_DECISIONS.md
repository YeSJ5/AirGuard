# AirGuard architecture decisions

**Basis:** source review on 2026-10-03. Running API, PostgreSQL, Redis, migrations, and production containers were unavailable, so “implemented” below means present in source and does not imply runtime verification.

## 1. Use provider observations; do not generate live aircraft

The active ingestion service queries OpenSky `/api/states/all`. It normalizes returned positions and retains field availability and observation timestamps. If the upstream feed fails, the live ingestion path marks it unavailable; it does not fill the map with generated tracks. Coverage is limited by provider reception, quota, account access, and successful requests. The public API's polling defaults are deliberately slower than per-aircraft observation resolution to respect provider quotas.

**Trade-off:** data may be sparse or stale. The UI must show source health and freshness rather than implying complete global coverage.

## 2. Keep unavailable evidence unavailable

Standard OpenSky state vectors do not include NIC/NACp, and sensor IDs are not calibrated receiver positions. The optional NIC rule therefore remains unassessed for this source; receiver consistency and multilateration remain unavailable. Missing numeric DB fields are accompanied by observed/missing-field metadata and must not be treated as real zeros by consumers.

**Trade-off:** fewer layers produce a score. This is preferable to fabricating independent verification or confidence.

## 3. Separate heuristic risk from trust and evidence coverage

Deterministic kinematic rules provide review signals when inputs are available. The fused value is a heuristic risk index, not calibrated probability, trust, safety, or airworthiness. `rule_assessment_coverage` reports the fraction of five rule inputs that were assessable; it is not confidence or correctness. Live ML defaults off, and no real-world validation metrics are claimed.

**Trade-off:** the current detector makes narrower claims and may report `INSUFFICIENT_EVIDENCE` frequently. Calibration and model activation require independently labeled, source-matched validation data.

## 4. Retain source observations and link every conclusion to them

Aircraft states and per-observation assessments are stored separately. A triggered alert captures rule evidence and available score provenance. State, assessment, and alert are committed in one database transaction; persistence failures propagate to the stream consumer for retry/dead-letter handling. The configured retention and database behavior still need operational verification.

**Trade-off:** retained evidence costs storage and requires retention policy. Any future compaction must preserve case snapshots and incident evidence.

## 5. Use Redis Streams for ingestion-to-detection decoupling

The source process batches normalized observations to `airguard:telemetry`; the detection consumer group processes aircraft-local sequences and acknowledges messages after persistence. Pending-message reclaim and dead-letter handling are implemented in source but have not been exercised against live Redis failures. When Redis is unavailable, local fallback processing is awaited to avoid overlapping per-aircraft history across poll cycles; failures are surfaced instead of silently reported as successful detection.

**Trade-off:** Redis and database availability affect end-to-end continuity. A live outage/restart exercise is required before claiming delivery guarantees.

## 6. Treat correlated candidates as leads, not events with known causes

Recent real alerts can be grouped by a configured space-time proximity rule. The candidate includes its method and source evidence. Creating a case revalidates the candidate against stored alerts and captures an evidence snapshot. Analyst dispositions and notes are append-only review records; they do not automatically retrain a model or prove a causal event.

**Trade-off:** simple proximity grouping can produce false associations or miss nonlocal patterns. It is intentionally labeled provisional until evaluated and enriched with justified behavioral features.

## 7. Keep frontend transport compatible with local and TLS deployments

Vite development uses the local API port. The built Docker frontend uses same-origin HTTP and WebSocket paths, proxied by Nginx to the API service. HTTPS deployments can therefore terminate TLS at their ingress without browser mixed-content calls. The container configuration has not been built or exercised in this environment.

## 8. Defer claims that require data or hardware the project does not have

Source adapters, receiver geometry, cross-source consistency, aircraft-specific behavioral baselines, calibrated trust, counterfactual explanations, and detector feedback evaluation remain future work. Implementing a UI element alone cannot make these observations available or validate the associated claims.

## Verification still required

- Apply the full Alembic chain on a clean PostgreSQL instance and upgrade a populated compatible database.
- Run API + Redis consumer + OpenSky ingestion together and reconcile raw, normalized, persisted, alerted, and displayed counts.
- Exercise Redis disconnect/restart, DB write failure, pending reclaim, duplicate delivery, and dead-letter recovery.
- Verify the frontend/API/WebSocket path through the Docker Nginx proxy in both local HTTP and TLS-terminated deployment.
- Validate model or rule performance only on independent labeled real telemetry; do not reuse synthetic benchmarks as ground truth.
