# AirGuard product vision

## Product thesis

AirGuard is an **airspace awareness and signal-quality learning platform**. It helps people explore reported aircraft movement, understand what an ADS-B report can and cannot tell them, and review unusual reports with their supporting evidence. Its differentiator is transparent provenance and interpretation, not a claim to display every aircraft or to certify that a signal is genuine.

## Who it serves

- **Public and aviation learners:** explore nearby reports, follow a track, learn altitude, speed, route and transponder concepts in plain language.
- **Researchers and students:** replay historical tracks, inspect data gaps and source coverage, and compare documented detector behaviour against labeled scenarios.
- **Airspace monitoring teams:** triage rule-based or model-generated review flags, inspect timestamps and evidence, and record operator decisions. AirGuard is decision support; it is not an air traffic control or flight-safety system.

## Product pillars

1. **Know what is being shown.** Every track comes from the configured live provider. Health views distinguish a successful poll from a rate limit, an outage, and a stale response.
2. **Follow a report over time.** Search, route context when available, history trails and playback make movement understandable. Unknown routes and missing receiver measurements remain explicitly unknown.
3. **Explain the evidence.** Review flags show which rules or detector outputs fired, with the source timestamp and available measurements. No active flag is not proof that a flight is safe, authentic or anomaly-free.
4. **Make aviation understandable.** Public-facing explanations teach concepts without exposing users to unexplained control-room jargon.
5. **Earn operational trust.** Operators need review history, data-quality reporting, role-appropriate access and reproducible evaluations before AirGuard can support real monitoring workflows.

## What the current project can honestly demonstrate

- A global aircraft-state feed integration, with quota-aware polling and explicit empty and unavailable states.
- Aircraft search, selection, route lookup where available, recent-track history, playback, map views and a browser-local nearby-aircraft view.
- A rule and model pipeline for flagging unusual telemetry, plus alert inspection and historical replay against the data currently stored by the application.
- Feed health and source provenance so users can understand the origin and freshness of each displayed report.

AirGuard requests the provider's global state feed and displays only real provider reports. It does not generate fallback tracks or promise complete worldwide surveillance: visibility depends on receiver coverage, aircraft transmissions, provider availability, and access quota. When no current reports are returned, the map remains empty and reports the feed condition.

## Distinctive major-project contribution

Build AirGuard around a **coverage and evidence observatory** rather than a generic moving-aircraft map:

- A coverage panel reports the requested region, last upstream success, current feed state, response volume, source mix and known data gaps.
- An aircraft record separates reported facts (position, altitude, speed, timestamp, source) from inferred context (route, operator, aircraft type) and detector conclusions.
- An alert investigation shows the exact observations and rules used, what evidence is missing, and an operator's disposition.
- A learning mode explains the selected track and concepts such as transponder identifiers, ground speed, altitude and stale reports.
- A research mode evaluates labeled, reproducible scenarios and displays dataset size, class balance, threshold settings and confusion-matrix metrics. It does not convert a synthetic benchmark into a real-world accuracy claim.

## Delivery sequence

### Foundation — data integrity

Keep live, delayed and unavailable feed states separate. Attach source and observation time to each record. Do not substitute generated aircraft when the provider is unavailable. Avoid fabricated RSSI, receiver quorum, registry provenance, trust values or historical baseline scores. Mark missing values as unavailable. Preserve that distinction in storage, API responses, charts and exports.

### Product workflows

Polish four complete user journeys: explore local airspace; find and follow a flight; investigate a review flag; and replay a selected historical window. Add useful filters, readable empty/error states, keyboard-accessible controls and responsive layouts. Keep map and list selection synchronized.

### Coverage intelligence

Add configurable regions, ingestion paging/tiling where the provider supports it, source-level quotas and freshness monitoring. Report coverage as measured observations and freshness over a stated area/time window, not as a guessed percentage of all global traffic. Add caching and incremental updates before raising poll frequency.

### Evidence network

Create a receiver adapter interface, receiver health/clock status and station registry. Only enable multilateration when multiple actual, time-synchronized receiver observations are available, with documented calibration and error bounds. Until that network exists, show receiver geometry as unavailable.

### Research and operations

Version the models, rule configuration and labeled datasets. Add reproducible benchmark runs, false-positive review, audit history, access policy and retention controls. Validate detectors against diverse labeled reports and adversarial cases before making operational performance claims.

## Dependencies and limits

Worldwide coverage, full commercial identity data, reliable origin/destination, raw RF strength, receiver-based multilateration and claims about real-world spoofing detection need external data agreements, receiver hardware, calibrated timestamps, labeled validation data and appropriate operational review. Those capabilities cannot be created by frontend changes alone. AirGuard should expose a clear integration boundary for them and remain useful with a limited regional feed.

## Success measures

- Every displayed track makes its source and freshness understandable.
- Users can find a track, inspect its path and replay a chosen interval without confusing a lookup estimate with an observed fact.
- Each alert can be traced to the exact reports, rule version and detector output that produced it.
- Coverage and missing-data explanations match measured feed activity.
- Public learners can explain what the displayed fields mean; operators can reproduce and audit an investigation.
- Benchmarks state the dataset and limits, and are repeatable from a versioned configuration.
