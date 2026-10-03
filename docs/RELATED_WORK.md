# Related Work & Prior Art

> Comparison notes below include historical capability and performance claims that have not been independently checked in this implementation pass. Treat them as literature-review leads, not evidence of AirGuard's validated performance. Current product scope is in [PRODUCT_VISION.md](PRODUCT_VISION.md).

## 1. Overview & Landscape

Unauthenticated radio broadcast protocols such as Automatic Dependent Surveillance-Broadcast (ADS-B, RTCA DO-260B) provide real-time situational awareness to Air Traffic Control (ATC) and airborne collision avoidance systems (TCAS). However, because ADS-B lacks cryptographic authentication or message integrity verification, civil aviation telemetry is vulnerable to electronic warfare, Global Navigation Satellite System (GNSS) jamming, and radio-frequency (RF) coordinate spoofing.

In recent years, several notable public, academic, and commercial initiatives have emerged to map or detect these vulnerabilities using crowdsourced receiver data. This document reviews the three closest and most prominent prior works—**GPSJam.org**, **SkAI Data Services + Zurich University of Applied Sciences (ZHAW)**, and **commercial flight tracker's GPS Jamming Map**—and explicitly delineates how AirGuard differs in architectural scope, detection methodology, explainability, and deployment model.

---

## 2. Detailed Review of Prior Work

### 2.1 GPSJam.org (John Wiseman)

- **What it does**:  
  GPSJam.org is a public situational awareness platform created by John Wiseman that visualizes daily global GPS interference zones using crowdsourced ADS-B telemetry from ADS-B Exchange. It aggregates daily flight reports into hexagonal geographic bins (Uber H3 spatial index) and calculates the percentage of aircraft broadcasting degraded Navigation Integrity Category ($\text{NIC} < 7$) or Navigation Accuracy Category ($\text{NACp} < 7$) indicators. Hexagonal cells where more than 2% or 10% of aircraft report low accuracy are colored yellow or red to identify active GNSS jamming corridors (e.g., Eastern Europe, the Baltic Sea, and the Middle East).

- **How AirGuard differs**:  
  While GPSJam provides an invaluable macro-level post-hoc heatmap of regional jamming, **AirGuard processes sub-second telemetry streams in real time ($< 500\text{ ms}$ latency) on a per-aircraft basis rather than publishing 24-hour historical cell averages**. Crucially, GPSJam relies exclusively on the aircraft's self-reported GPS accuracy; if an adversary executes coordinate spoofing while broadcasting a forged valid accuracy category ($\text{NIC} \ge 7$), GPSJam cannot detect the attack. In contrast, AirGuard evaluates aerodynamic kinetic conservation (implied Mach limits, climb limits, duplicate ICAO collisions) and machine learning variance profiles, detecting spoofed trajectories regardless of the aircraft's self-reported transponder status. Furthermore, AirGuard provides per-alert SHAP explainability and rolling aircraft trust trajectories that GPSJam does not attempt to compute.

---

### 2.2 SkAI Data Services & Zurich University of Applied Sciences (ZHAW) / GPSwise

- **What it does**:  
  Developed jointly by researchers at the ZHAW Centre for Aviation and SkAI Data Services (led by Dr. Vincent Lenders and commercialized as GPSwise), this project provides a near-real-time GPS spoofing detection tracker leveraging ADS-B telemetry from the OpenSky Network. Their methodology identifies spoofing events primarily by detecting geometric trajectory anomalies across multiple aircraft (such as "hotspot convergence" where multiple aircraft are forced to report identical coordinates, or artificial circular orbits drawn near contested airports like Tel Aviv or Beirut) and cross-checking ADS-B reports against Multilateration (MLAT / TDoA) calculated across OpenSky's worldwide terrestrial receiver grid.

- **How AirGuard differs**:  
  SkAI / ZHAW represents the closest and most sophisticated prior work to AirGuard, but key architectural differences define AirGuard's scope:
  1. **Multi-Layer Hybrid Pipeline with Unsupervised Zero-Day Detection**: SkAI focuses on geometric pattern clustering and crowdsourced MLAT. AirGuard integrates four complementary defense tiers: deterministic kinematic boundary rules + a supervised gradient-boosted ensemble (Random Forest + GBDT) + a deep unsupervised PyTorch autoencoder (which detects out-of-distribution variance spikes without requiring labeled attack examples) + simulated receiver trilateration geometry.
  2. **Explainable AI (XAI) with SHAP Attribution**: SkAI yields an incident-level classification or cluster flag. AirGuard computes local TreeExplainer SHAP values for every individual alert, attributing exact mathematical risk contributions to specific features (e.g., altitude rate vs. heading variance vs. self-reported NIC) so radar controllers receive glass-box justification rather than a black-box anomaly flag.
  3. **Continuous Rolling Trust Score vs. Event Trigger**: Rather than issuing discrete point-in-time alert flags, AirGuard maintains an exponentially smoothed rolling trust score ($0\text{--}100$) across an aircraft's active flight session. This visually and mathematically differentiates slow signal degradation (e.g., jamming or antenna masking) from sharp, instantaneous step discontinuities (e.g., coordinate injection).
  4. **Self-Contained Ground-Station Deployment**: SkAI operates as a centralized cloud service dependent on OpenSky's global terrestrial receiver network. AirGuard is designed as an autonomous, self-contained ground-station appliance that can be deployed by a single airport, base, or mobile radar unit on local hardware without reliance on external cloud infrastructure.

---

### 2.3 commercial flight tracker GPS Jamming & Interference Overlay

- **What it does**:  
  commercial flight tracker provides a commercial GPS interference mapping overlay integrated into its flight-tracking ecosystem. The tool ingests real-time transponder data across commercial flight tracker's global feeder network and calculates the proportion of aircraft reporting degraded navigation accuracy (NIC and NACp values below standard operational thresholds) over regional grid cells across 6-hour and 24-hour sliding windows.

- **How AirGuard differs**:  
  commercial flight tracker's interference map is a **macro-level commercial situational awareness overlay, not an automated intrusion detection system (IDS)**. It does not monitor individual aircraft for malicious trajectory tampering, does not isolate rogue transmitters, and does not raise security incident alerts. Like GPSJam, it depends entirely on self-reported transponder integrity: a sophisticated attacker spoofing coordinates with a forged high NIC appears entirely normal on commercial flight tracker. AirGuard validates physical kinetics and multivariate trajectory dynamics independently of self-reported indicators, offers automated PDF forensic incident reporting, and includes cryptographic audit ledgers.

---

## 3. Comparative Architecture Matrix

| Capability / Dimension | GPSJam.org (Wiseman) | SkAI + ZHAW (GPSwise) | commercial flight tracker Overlay | AirGuard (This Work) |
| :--- | :---: | :---: | :---: | :---: |
| **Primary Scope** | Macro Jamming Map | Spoofing Event Tracker | Macro Jamming Overlay | Ground-Station IDS & Trust Engine |
| **Analysis Granularity** | Regional H3 Hex Bins | Multi-Aircraft Clusters | Regional Spatial Grids | Per-Aircraft State Vector & Session |
| **Processing Latency** | 24-Hour Batch Aggregation | Near-Real-Time Stream | Sliding 6h/24h Windows | Real-Time Sub-Second ($< 500\text{ ms}$) |
| **Kinematic Physics Rules** | No | Secondary | No | **Yes** (Implied velocity, climb, ICAO) |
| **Supervised Machine Learning** | No | Proprietary heuristics | No | **Yes** (Random Forest + GBDT) |
| **Unsupervised Deep Learning** | No | No | No | **Yes** (PyTorch Autoencoder MSE) |
| **Independent Receiver Cross-Check** | No | Yes (OpenSky MLAT) | No | **Yes** (Local Multi-Sensor Trilateration) |
| **Explainable AI (XAI)** | No | No | No | **Yes** (Local TreeExplainer SHAP) |
| **Temporal Trust Tracking** | No | No (Event-based) | No | **Yes** (Rolling 0–100 Trust History) |
| **Deceptive Spoofing Detection** (Forged High NIC) | No (Bypassed) | Yes (via MLAT/Patterns) | No (Bypassed) | **Yes** (Kinematic + ML Variance) |
| **Deployment Model** | Public Web Service | Centralized Cloud Service | Commercial Web Platform | Self-Contained Edge Ground Station |

---

## 4. Condensed Version for Project Report / Viva Defense

> ### Related Work & Prior Art Summary
> 
> Existing public and commercial systems for monitoring ADS-B vulnerabilities primarily focus on regional GPS jamming visualization rather than per-aircraft threat detection:
> 
> 1. **GPSJam.org (John Wiseman)** maps global GPS interference by aggregating the percentage of aircraft broadcasting degraded Navigation Integrity Category ($\text{NIC} < 7$) into daily hexagonal bins.  
>    *How AirGuard differs*: GPSJam produces a 24-hour batch map based entirely on self-reported GPS accuracy. AirGuard operates in real time ($< 500\text{ ms}$) on individual aircraft state vectors, validating physical kinematics (implied velocity, climb limits) and detecting spoofed trajectories even when an attacker deceives the receiver by broadcasting a forged high NIC.
> 
> 2. **SkAI Data Services & Zurich University of Applied Sciences (ZHAW / GPSwise)** is the closest existing prior work, tracking live GPS spoofing on OpenSky Network data by identifying geometric trajectory anomalies (e.g., circular flight paths, multiple aircraft reporting identical coordinates) and verifying signals against OpenSky's global Multilateration (MLAT) receiver grid.  
>    *How AirGuard differs*: Rather than relying solely on geometric clustering and centralized MLAT, AirGuard introduces: (a) a four-layer hybrid defense combining deterministic physics rules, a supervised ensemble (RF + GBDT), and deep unsupervised autoencoders for zero-day variance detection; (b) local SHAP attribution explaining the exact feature contribution behind every alert; (c) a rolling session trust-score ($0\text{--}100$) distinguishing slow signal degradation from step injection; and (d) an autonomous, locally deployable ground-station architecture independent of global cloud aggregators.
> 
> 3. **commercial flight tracker GPS Jamming Map** provides a commercial situational awareness overlay displaying regional proportions of aircraft broadcasting low NIC/NACp accuracy over 6-hour and 24-hour windows.  
>    *How AirGuard differs*: commercial flight tracker offers a passive macro visualization without intrusion detection capabilities. AirGuard functions as an active radar intrusion detection system, applying multi-layer classification, multi-sensor trilateration plausibility checks, and automated forensic reporting.

