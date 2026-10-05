# Related work and AirGuard's scope

## Product landscape

AirGuard should be evaluated alongside several established categories:

- **Flight tracking and surveillance aggregation** provide broad aircraft observation, routes, history, and map-based situational awareness.
- **GNSS interference mapping** summarizes navigation-quality indicators over geographic areas and time windows.
- **Surveillance validation and monitoring** assess the quality and consistency of surveillance data in operational contexts.
- **Research anomaly detectors** study kinematic, spatial, or machine-learning methods for identifying unusual telemetry.

The master product brief explicitly recognizes that these capabilities already exist across commercial, research, and operational systems. AirGuard should not claim to have invented global tracking, GNSS interference mapping, surveillance validation, multi-aircraft correlation, or anomaly detection. See the [OpenSky API documentation](https://openskynetwork.github.io/opensky-api/) for the configured source's published scope and limitations.

## AirGuard's intended contribution

AirGuard's differentiator is an integrated analyst workflow over the observations it actually receives:

**observe → check field availability and freshness → preserve detector evidence → derive provisional cross-aircraft candidates → capture an immutable investigation snapshot → record an analyst disposition and rationale.**

The value is traceability and review: an analyst can follow an assessment back to source observations, see which checks were assessable, and distinguish an observed correlation from a causal finding. The map and any model are supporting tools, not the product claim.

## Current implementation boundary

| Capability | Current status |
| --- | --- |
| Global aircraft observation | OpenSky global state query; coverage and cadence depend on provider, receivers, credentials, and quota. It is not a complete global census. |
| Source observations and data quality | Normalized, retained with observed/missing-field metadata, and shown with source timestamps. |
| Kinematic rule evidence | Limited deterministic checks are evaluated when required inputs are available. A flag is a review lead, not proof of an attack. |
| Research ML | Present in source with local artifacts, but disabled by default and not validated for live use. Historical synthetic benchmark claims are not operational performance evidence. |
| NIC / navigation integrity | The configured standard OpenSky state-vector response omits NIC/NACp. The optional NIC rule is unassessed for this feed. |
| Independent receiver verification | Unavailable. No calibrated, synchronized receiver observation network is configured. |
| Cross-aircraft analysis | Provisional space-time groups derived from recent persisted real alerts. Proximity is not causality. |
| Investigation | Cases preserve server-revalidated alert evidence and analyst review history; runtime and migration still require verification. |
| Calibrated trust, threat, or safety judgment | Not implemented or claimed. Risk is a heuristic triage index; rule assessment coverage is not confidence. |

## Claims AirGuard must avoid

Until supported by additional sources and independent validation, do not claim:

- that AirGuard tracks more aircraft or provides better coverage than established trackers;
- that a displayed aircraft position has been independently verified;
- that an alert proves spoofing, malicious intent, or an unsafe aircraft;
- that AirGuard has calibrated trust/confidence values, receiver multilateration, or cross-source consistency;
- that synthetic-data scores establish real-world precision, recall, or generalization;
- that space-time proximity identifies a common event cause.

## Evaluation needed for a defensible comparison

1. Define the use case and observation-area/time coverage for each source.
2. Assemble independently labeled, source-matched telemetry and benign edge cases.
3. Split validation by aircraft and time to avoid leakage; report class balance, uncertainty, calibration, and error types.
4. Measure end-to-end ingestion freshness, persistence continuity, detector throughput, and case auditability on the deployed stack.
5. Compare against published and operational baselines using the same data, definitions, and evaluation windows.

The current project has not completed these comparisons. Its defensible academic contribution today is the implementation direction—evidence provenance, explicit uncertainty, provisional correlation, and an auditable human review path—not a proven detection advantage.
