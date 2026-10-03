# Historical Model Card Draft — Reproduction Required

> **Status: not an operational model card.** Benchmark numbers and generalization statements below are legacy claims that have not been reproduced in this review. Do not present them as validated real-world performance. Current product scope and the required validation work are described in [PRODUCT_VISION.md](PRODUCT_VISION.md).

## Model Details
- **Developed by**: AirGuard Security Team
- **Model Date**: August 2026
- **Model Type**: Hybrid Trust Scoring Pipeline:
  1. **Supervised Soft-Voting Ensemble**: Scikit-Learn RandomForest + Gradient Boosting Classifiers.
  2. **Unsupervised Deep Autoencoder**: PyTorch Multi-layer Feedforward neural network.
- **Primary Objective (intended)**: Flag unusual ADS-B state vectors for review using physical rules, feature analysis and available model outputs. Outputs are not calibrated probabilities or aircraft safety ratings.

## Intended Use
- **Primary Use Case**: Live ground-station monitoring to detect transponder anomalies such as:
  - **GPS Spoofing / Meaconing**: Aircraft reporting false positions that deviate from physical flight dynamics.
  - **Ghost Aircraft Injections**: Insertion of synthetic transponder signals by RF transmitters on the ground.
- **Intended Users**: Aviation safety researchers, amateur ground station operators, airport security teams.
- **Out of Scope**: Safety-critical air traffic collision avoidance (e.g., TCAS replacement).

## Training Data & Synthetic Methodology
Due to the rarity of actual transponder spoofing and RF injection attacks in civil aviation, there is insufficient real-world threat telemetry. To train supervised models, we generate a synthetic training set:
- **Baseline Normal Class (1,000 samples)**: Simulated normal flight dynamics using historical OpenSky parameters (low speed/heading variances, standard 8s intervals, no rule triggers).
- **Injected Anomaly Class (1,000 samples)**: Programmatic threat injections covering:
  - **Position Jumps**: Implied speed anomalies exceeding 1200 km/h with high speed/heading variances.
  - **Duplicate ICAO**: Simultaneous reports from different locations within the same second.
  - **Climb Rate Anomalies**: Altitude vertical speed exceeding ±50 m/s.
  - **Altitude/Velocity Mismatches**: Inconsistent attributes (e.g. flying speed while reported taxiing on the ground, or stationary in the air at 0m altitude).
  - **Low Signal Confidence + Displacement**: Self-reported Navigation Integrity Category degradation (NIC < 7) coupled with significant position jumps (> 10 km).

### Real-World Precedent: GPSJam.org & Self-Reported Navigation Integrity
Unlike purely derived kinematic checks (implied speed or climb rate), ADS-B transponders compliant with RTCA DO-260B honestly broadcast their onboard avionics' GPS integrity:
- **Navigation Integrity Category (NIC, 0–11)**: Encodes the containment radius \(R_c\). Controlled civil airspace mandates \(\text{NIC} \ge 7\) (\(R_c < 0.2\text{ NM}\) / ~370 m).
- **Navigation Accuracy Category for Position (NACp, 0–11)**: Encodes estimated 95% horizontal position uncertainty.

When an aircraft encounters electronic warfare, GPS jamming, or spoofing (meaconing), the onboard GNSS receiver loses satellite carrier-to-noise ratio or triggers Receiver Autonomous Integrity Monitoring (RAIM) faults, immediately degrading the broadcast NIC and NACp values. **[GPSJam.org](https://gpsjam.org)** uses this exact underlying telemetry from global ADS-B receiver networks to generate authoritative daily maps of GNSS interference zones (e.g., Eastern Europe, Middle East, Baltic Sea). 

Citing GPSJam.org provides empirical real-world validation that self-reported transponder integrity degradation is an internationally proven signal for detecting electronic interference. AirGuard incorporates this via the `reported_nic` column and the `low_signal_confidence` rule: by requiring both low confidence (\(\text{NIC} < 7\)) and significant spatial displacement (\(> 10\text{ km}\)), the system avoids false alarms from benign transient drops (such as steep banking antenna masking) while decisively catching active spoofing telemetry.

### Limitations for Real-world Generalization
- **Feature Simplicity**: The synthetic data uses clean, mathematical noise distributions (normal, exponential) that do not model microsecond arrival jitter, multipath reflections, or antenna polarization.
- **Overfitting to Explicit Rules**: Because the model relies on binary rule flags as inputs alongside rolling variance features, it may struggle with "stealthy" spoofing attacks that stay just below rule thresholds (e.g. slow drifts).
- **Receiver Noise Sensitivity**: Real-world packet loss and timing sync errors between stations can mimic "duplicate ICAO" or "position jumps", causing elevated False Positive Rates (FPR) not observed in synthetic testing.

## Model Implementations

### 1. Trust Scoring Ensemble
- **Classifier**: Combines RandomForestClassifier (weights=0.6) and GradientBoostingClassifier (weights=0.4).
- **Input Dimensions**: 9 features:
  1. `speed_variance` (rolling 5-state window)
  2. `heading_variance` (rolling 5-state window)
  3. `altitude_rate_variance` (rolling 5-state window)
  4. `time_since_last_update` (seconds delta)
  5. `rule_position_jump` (binary)
  6. `rule_duplicate_icao` (binary)
  7. `rule_climb_rate` (binary)
  8. `rule_alt_vel_mismatch` (binary)
  9. `rule_low_signal_confidence` (binary, NIC < 7 + spatial jump > 10 km)
- **Metrics Comparison in `model_runs`**:
  - **v0.1.0 Baseline (8 features)**:
    - **Precision**: 0.985
    - **Recall**: 0.962
    - **F1-Score**: 0.973
  - **v0.2.0 Run (9 features, including `rule_low_signal_confidence`)**:
    - **Precision**: 1.0000 (0 false positives on 400 test samples)
    - **Recall**: 1.0000 (0 false negatives on 400 test samples)
    - **F1-Score**: 1.0000
    - **Outcome**: The addition of `rule_low_signal_confidence` eliminated ambiguous edge-case misclassifications where low-variance spoofed positions might have previously evaded kinematic thresholds, achieving perfect separation on the synthetic test benchmark.
- **Explainability**: Initialized via SHAP `TreeExplainer` on the RandomForest sub-estimator (`ensemble.named_estimators_['rf']`) to extract feature importance vectors and assign top explanations in plain English.

### 2. Deep Unsupervised Autoencoder
- **Architecture**: PyTorch model with layout:
  - Input (size 5) -> Linear (32) -> ReLU -> Linear (16) -> ReLU -> Bottleneck (8) -> Linear (16) -> ReLU -> Linear (32) -> ReLU -> Output (size 5).
- **Detection Criteria**: Computes mean squared reconstruction error (MSE). Telemetry is marked anomalous if MSE exceeds the threshold value of `0.05`.

### 3. Combined Risk Score
- Combined risk scores are aggregated as a weighted mean of the rule triggers, supervised ensemble probability, and autoencoder reconstruction errors:
  \[
  \text{Score} = 0.5 \times \text{Rules} + 0.3 \times \text{Ensemble} + 0.2 \times \text{Autoencoder}
  \]
- If the Combined Risk Score crosses `0.7`, a security alert is logged.

### 4. Multi-Layer Architectural Ablation Study

To empirically validate the defense-in-depth architecture rather than simply claiming ensemble benefits, we conducted a systematic ablation study using `backend/scripts/run_ablation_study.py`. The benchmark evaluated a held-out evaluation set of 400 telemetry vectors (199 benign flights with turbulence/maneuvering noise, and 201 anomalous vectors containing spoofing, jumps, duplicate ICAOs, and confidence drops) across four isolated configurations:

| Configuration | Precision | Recall | F1-Score | False-Positive Rate (FPR) | TP | FP | TN | FN |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Rules-Only** | 1.0000 | 1.0000 | 1.0000 | 0.0000 (0.0%) | 201 | 0 | 199 | 0 |
| **2. Ensemble-Only** (RF + GBDT, continuous features only) | 0.9526 | 1.0000 | 0.9757 | 0.0503 (5.03%) | 201 | 10 | 189 | 0 |
| **3. Autoencoder-Only** (Unsupervised PyTorch MSE) | 0.4882 | 0.9254 | 0.6392 | 0.9799 (97.99%) | 186 | 195 | 4 | 15 |
| **4. Full Combined Pipeline** (Rules + Ensemble + Autoencoder) | **1.0000** | **1.0000** | **1.0000** | **0.0000 (0.0%)** | **201** | **0** | **199** | **0** |

#### Quantitative Findings & Analysis
The full combined pipeline reduced false positives by 100% relative to the best single-layer machine learning configuration (completely eliminating all 10 false alarms observed in the standalone ensemble model, driving FPR down from 5.03% to 0.00%) while preserving 100% attack recall on the held-out evaluation set.

While the supervised ensemble achieves high recall on its own, relying on variance features alone causes it to occasionally confuse sharp, lawful turns or turbulent gusts with trajectory tampering (10 false positives). Conversely, unsupervised autoencoders on raw variance features trigger frequent false alarms (97.99% FPR) because high variance does not inherently imply hostility. Meanwhile, deterministic rules, though exhibiting zero false positives on explicit physical boundary breaches, lack probabilistic nuance or sensitivity to subtle sub-threshold drifts.

By integrating physics-based deterministic barriers with the supervised gradient-boosted ensemble and autoencoder reconstruction scoring into a unified risk metric, the combined architecture eliminates alert fatigue without compromising detection sensitivity. Each ablation run is immutably recorded in the PostgreSQL `model_runs` audit ledger (`abl-rules`, `abl-ensemble`, `abl-ae`, `abl-combined`) and visualized live within the frontend Analytics console.

