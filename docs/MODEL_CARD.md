# Model Card - AirGuard Trust Scoring Engine

## Model Details
- **Developed by**: AirGuard Security Team
- **Model Date**: August 2026
- **Model Type**: Hybrid Trust Scoring Pipeline:
  1. **Supervised Soft-Voting Ensemble**: Scikit-Learn RandomForest + Gradient Boosting Classifiers.
  2. **Unsupervised Deep Autoencoder**: PyTorch Multi-layer Feedforward neural network.
- **Primary Objective**: Compute real-time anomaly probability and generate trust scores for ADS-B state vectors based on physical envelopes, variances, and rule triggers.

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

### Limitations for Real-world Generalization
- **Feature Simplicity**: The synthetic data uses clean, mathematical noise distributions (normal, exponential) that do not model microsecond arrival jitter, multipath reflections, or antenna polarization.
- **Overfitting to Explicit Rules**: Because the model relies heavily on the four binary rule flags as inputs, it may struggle with "stealthy" spoofing attacks that stay just below rule thresholds (e.g. slow drifts).
- **Receiver Noise Sensitivity**: Real-world packet loss and timing sync errors between stations can mimic "duplicate ICAO" or "position jumps", causing elevated False Positive Rates (FPR) not observed in synthetic testing.

## Model Implementations

### 1. Trust Scoring Ensemble
- **Classifier**: Combines RandomForestClassifier (weights=0.6) and GradientBoostingClassifier (weights=0.4).
- **Input Dimensions**: 6 features representing physical variances (climb rate, speed, distance deltas) and binary rule flags.
- **Metrics (v0.1.0 Synthetic Baseline)**:
  - **Precision**: 0.985
  - **Recall**: 0.962
  - **F1-Score**: 0.973
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
