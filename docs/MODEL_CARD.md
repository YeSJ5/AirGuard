# AirGuard detector and evidence card

**Scope reviewed:** repository source on 2026-10-03. Backend runtime, database migration, and live feed behavior were not available for end-to-end verification. This card describes the source implementation, not aviation safety or operational surveillance performance.

## Purpose and limits

AirGuard stores aircraft observations returned by its configured OpenSky global state query and evaluates a small set of telemetry consistency rules. It attaches available evidence to an aircraft observation so an analyst can inspect it. It is not a safety service, airworthiness judgment, spoofing verdict, or substitute for validated surveillance systems.

The feed is not a complete census. Visibility depends on receiver coverage, aircraft transmissions, provider availability, credentials, and API quota. AirGuard does not generate replacement aircraft when the provider is unavailable. See [the live-feed guide](LIVE_FEED_GUIDE.md).

## Data and provenance

- Live input is OpenSky `/api/states/all` as normalized by `backend/app/ingestion/service.py`.
- The standard state vector contains fields 0–17. It includes receiver identifiers but no NIC/NACp field; AirGuard does not infer receiver locations from those IDs. See the [official state-vector field list](https://openskynetwork.github.io/opensky-api/rest.html#all-state-vectors).
- The normalizer rejects missing or out-of-range coordinates. It preserves which kinematic fields were actually present and records a timestamp source.
- Missing numeric values are persisted as compatibility zeros only alongside `data_quality.observed_fields` / `missing_fields`. Consumers must gate calculations on these fields.
- An optional NIC rule exists in source, but standard OpenSky vectors do not supply its input. It is therefore unassessed for the configured live feed.
- Receiver-based consistency and multilateration return unavailable. There is no calibrated, time-synchronized station observation network configured.

## Implemented live assessment

The deterministic rules cover position discontinuity, duplicate ICAO observations, climb-rate bounds, ground/air kinematic mismatch, and optional low-NIC plus displacement. A rule is `true`, `false`, or `null` when its input cannot be assessed. An unavailable input must not be interpreted as a pass.

`combine_scores` fuses rule outputs and optional model/receiver outputs only when present. The resulting 0–1 value is a heuristic detector risk index. It is neither calibrated probability nor trust. A score alone is not proof of spoofing or unsafe operation. The current live ML setting defaults off; the standard feed also leaves NIC and receiver geometry unavailable. In normal live configuration, risk is therefore driven by assessable deterministic rules.

`AircraftAssessment.rule_assessment_coverage` is the fraction of the five implemented rule inputs that were assessable for that observation. It is a coverage count, not evidence confidence, data truth, or detector correctness. Risk and rule coverage must remain separate in UI and downstream analysis.

Assessments store the rule flags, available model/receiver values, data-quality metadata, live-ML setting, detector version, and assessment timestamp. Alert evidence stores the rule-specific evidence and available scores. State, assessment, and a triggered alert are written in one database transaction.

## Optional research models

The repository includes a Random Forest / Gradient Boosting ensemble and a PyTorch autoencoder with model artifacts. They are disabled for live decisions by default (`ENABLE_LIVE_ML=false`); code presence or artifact presence does not establish model validity. The autoencoder source uses a 4→8→3→8→4 network. Model outputs must remain unavailable unless the setting is enabled, weights load, inputs are assessable, and the output is recorded with provenance.

Training and ablation scripts generate synthetic examples. Those examples can support software-path exploration only. They are not representative live-aircraft validation data. No real-world precision, recall, false-positive rate, calibration, generalization, or spoofing-detection performance is claimed here. Historical benchmark numbers were removed because they were not reproducible from the current live implementation and must not be used as evidence.

## Analyst interpretation

- `INSUFFICIENT_EVIDENCE` is a valid result. Do not convert missing fields or unavailable layers to zero-risk or high-trust conclusions.
- A rule flag is a lead to review. It does not establish cause or intent.
- Multiple nearby flagged aircraft form a provisional space-time candidate only. Proximity does not show common cause.
- Event case dispositions are analyst judgments over an immutable captured evidence snapshot; they do not automatically retrain or alter detector logic.

## Validation still required

1. Reproduce migrations and live API behavior on PostgreSQL and Redis.
2. Measure per-field availability, source freshness, feed gaps, and worker persistence under normal operation and service failure.
3. Version rule definitions and thresholds in each assessment.
4. Evaluate detector behavior on independently labeled, source-matched real observations, including benign operational edge cases; report uncertainty and class balance.
5. Validate any candidate probabilistic model on a held-out dataset split by aircraft and time, with calibration and model disagreement evidence before enabling live use.
6. Add additional authorized sources and receiver observations before showing cross-source or receiver consistency as available.
