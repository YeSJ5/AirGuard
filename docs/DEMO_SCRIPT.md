# Demo Script & Live Narration Walkthrough

This document outlines a minute-by-minute live narration guide for demonstrating the capabilities of the **AirGuard** ADS-B trust-scoring ground station.

---

## Prerequisites & Setup
Ensure the full stack is running via Docker Compose:
```bash
# Start all containers in the background (fresh build)
docker-compose -f docker/docker-compose.yml up --build -d
```
Verify health endpoints:
- Frontend: `http://localhost:3000`
- Backend REST API: `http://localhost:8000/health`

---

## Live Walkthrough Timeline

### Minute 0:00 - 0:30: The Landing & Hero Statement
1. Navigate to the landing page at `http://localhost:3000`.
2. **Visual Focus**: Draw attention to the bold hero headline:
   > *"FlightRadar24 tells you where a plane is. We tell you whether you should trust that."*
3. **Narration**: Explain the core vulnerability—ADS-B signals are civil broadcasts lacking authentication. Point to the live system health stat strip verifying that the receiver's queue is empty and the database connection is healthy.
4. **Action**: Click the **"OPEN RADAR CONSOLE"** Call-to-Action button to transition into the Dashboard.

### Minute 0:30 - 1:00: Dashboard Console Overview
1. **Visual Focus**: Show the tactical dark-themed interface:
   - **Header Tab Navigation**: System Overview, Tactical Screen, Historical Playback, Analytics & Config.
   - **Connection Status Badge**: Blinking cyan indicating live WebSocket streams.
   - **3D Cesium Globe**: Tracks active flight polylines.
   - **Virtualized List**: Scroll smoothly through simulated flights to demonstrate 60fps performance under high traffic load.
2. **Narration**: Explain how the virtualized list keeps the UI highly responsive by rendering only visible items.

### Minute 1:00 - 2:00: Live Anomaly Injection & Ingestor CLI
1. Open a terminal to execute the Python anomaly injector script in batch mode:
   ```bash
   poetry run python scripts/inject_anomaly.py --batch
   ```
2. **Visual Focus**: As the script prints out injection parameters (ICAO24, climb limits, position delta), watch the WebSocket stream update the dashboard in real-time.
3. **Narration**: Let the audience see the alerts appear instantly on the dashboard:
   - Point to the **Security Anomalies** counter card in the bottom footer incrementing immediately.
   - Explain that the telemetry is being piped dynamically into the background queue loop, re-evaluating rules and feeding the ML models.

### Minute 2:00 - 3:00: Flagged Targets & SHAP Explanations
1. **Action**: Select the newly flagged aircraft (e.g. `AAL102` or `SWA931`) from the virtualized list.
2. **Visual Focus**: Point out the sliding **Detail Drawer** showing:
   - **Physical Rule Violations**: E.g., duplicate ICAO, vertical climb rate spikes.
   - **Trilateration status**: Ground receiver geometry checking.
   - **SHAP Explanation Bar Chart**: Horizontal bars showing which feature (climb rate, speed, or signal horizontal limit) contributed most to the ML classifier's threat rating.
3. **Narration**: Explain why explainability is crucial for operators. *"Instead of just giving a black-box trust score, the SHAP charts tell the controller exactly why the model is suspicious of this flight path."*

### Minute 3:00 - 4:00: System Analytics & Re-tuning Config
1. **Action**: Click the **"ANALYTICS & CONFIG"** tab in the header.
2. **Visual Focus**:
   - Point to the precision/recall metrics, confusion matrix counts (TP, FP, TN, FN), and charts detailing accuracy-over-time.
   - Change thresholds via the sliders on the right panel (e.g., lower the climb rate ceiling or speed limits).
   - Click the **"TEST AGAINST LAST SESSION (REPLAY)"** button.
3. **Narration**: The system re-evaluates database logs against the new limits, showing updated confusion matrices and live accuracy results instantly.

### Minute 4:00 - 5:00: Session Audits & Fallback Plan
1. **Action**: Navigate back to the **ALERTS AUDIT LOG** tab, export log records to CSV, and click **"GENERATE SESSION REPORT"** to download a ReportLab compiled PDF.
2. **Narration**: Highlight the fallback system capability:
   - Open **"HISTORICAL PLAYBACK"**. Explain that if the local SDR receivers go offline or DB access fails during judging, this play/pause playback driven by the pre-recorded fixture data ensures the demonstration remains fully functional.
3. Click play, adjust speeds (`1x`/`5x`/`20x`), scrub the slider, and show the simulated logs.
