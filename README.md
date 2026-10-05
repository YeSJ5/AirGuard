# 🛡️ AirGuard — Autonomous ADS-B Telemetry Verification & Airspace Anomaly Detection Platform

[![FastAPI](https://img.shields.io/badge/FastAPI-0.111+-009688.svg?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB.svg?logo=python&logoColor=white)](https://www.python.org)
[![React](https://img.shields.io/badge/React-18.3+-61DAFB.svg?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PyTorch](https://img.shields.io/badge/PyTorch-2.3+-EE4C2C.svg?logo=pytorch&logoColor=white)](https://pytorch.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-4169E1.svg?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7+-DC382D.svg?logo=redis&logoColor=white)](https://redis.io)
[![CesiumJS](https://img.shields.io/badge/CesiumJS-3D_Globe-68BBE3.svg)](https://cesium.com)

**AirGuard** is a real-time airspace monitoring, ADS-B signal verification, and multi-tier anomaly detection system. It ingests live global ADS-B telemetry, evaluates signal fidelity through a hybrid machine learning and physics-based validation pipeline, computes dynamic trust scores, and streams verified airspace data to an interactive 2D radar and 3D globe dashboard.

---

## 📑 Table of Contents

- [Key Capabilities](#-key-capabilities)
- [System Architecture](#-system-architecture)
- [Detection Pipeline Tiers](#-detection-pipeline-tiers)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Option 1: Docker Compose (Recommended)](#option-1-docker-compose-recommended)
  - [Option 2: Local Development Setup](#option-2-local-development-setup)
- [Environment Configuration](#-environment-configuration)
- [Available Commands & Makefile](#-available-commands--makefile)
- [API & Streaming Specifications](#-api--streaming-specifications)
- [Project Structure](#-project-structure)
- [Testing & Quality Assurance](#-testing--quality-assurance)
- [License & Disclaimer](#-license--disclaimer)

---

## 🚀 Key Capabilities

- **Real-Time ADS-B Ingestion & Streaming**: Seamless ingestion of live global aircraft positions via OpenSky Network (with OAuth2 authentication and automatic fallback), distributed across workers via Redis Streams and broadcast over WebSockets at sub-second latency.
- **4-Tier Multi-Layer Detection Engine**:
  1. *Kinematic Rule Validation*: Transponder physics checks (Mach limits, teleportation jump detection, climb/descent rate ceilings, heading rate of change).
  2. *Deep Autoencoder (PyTorch)*: Unsupervised multivariate reconstruction error analysis for novel or subtle anomaly patterns.
  3. *Supervised Soft-Voting Ensemble (RF + LightGBM/GB)*: Binary classification of spoofed vs. authentic transponder signals.
  4. *SHAP Feature Explainability*: Real-time feature importance attribution explaining *why* an aircraft received an anomaly score.
- **Dynamic Bayesian Trust Scoring & Decay**: Continual Bayesian score convergence and exponential moving average (EMA) decay modeling transponder trust over time.
- **Interactive Dual-Mode Airspace Visualizer**:
  - **2D Radar Interface**: High-performance canvas radar with vector dead-reckoning motion interpolation, squawk code indicators, and alert notifications.
  - **3D CesiumJS Globe**: Volumetric airspace navigation, real elevation rendering, altitude breadcrumbs, and chase-camera tracking.
- **Historical Timeline Playback & Forensics**:
  - Step-by-step airspace state replay with variable speed (0.5x to 8x), timeline scrubbing, and candidate event review.
  - Automated PDF forensic investigation reports generated on-demand via ReportLab.
- **Auditory Warning System**: Spatialized audio alarms synthesized dynamically via Web Audio API based on threat severity.

---

## 🏗️ System Architecture

```mermaid
flowchart TB
    subgraph DataSources["External Data Providers"]
        OSN["OpenSky Network API\n(OAuth2 / REST)"]
        SYNTH["Synthetic & Showcase\nTraffic Generator"]
    end

    subgraph IngestionWorker["Ingestion & Detection Service"]
        INGEST["Ingestion Service\n(De-duplication & Validation)"]
        STREAM["Redis Stream Producer\n(telemetry:stream)"]
        WORKER["Redis Stream Worker Pool\n(Consumer Groups)"]
        
        subgraph Pipeline["4-Tier Detection Pipeline"]
            T1["Tier 1: Kinematic Rules"]
            T2["Tier 2: PyTorch Autoencoder"]
            T3["Tier 3: Supervised Ensemble + SHAP"]
            T4["Tier 4: Trust Score Decay"]
        end
    end

    subgraph Storage["Data & Cache Layer"]
        PG[("PostgreSQL\n(States, Routes, Alerts, Events)")]
        REDIS[("Redis\n(Pub/Sub, Stream, Cache)")]
    end

    subgraph API["FastAPI Application Server"]
        REST["REST API Endpoints\n(/api/v1/aircraft, /routes, /events)"]
        WS["WebSocket Broadcaster\n(/api/v1/ws/airspace)"]
        PDF["PDF Report Engine\n(ReportLab)"]
    end

    subgraph Frontend["React 18 + Vite Frontend Dashboard"]
        RADAR["2D Radar Layer\n(Leaflet + Motion Interp)"]
        GLOBE["3D Airspace Globe\n(CesiumJS / Resium)"]
        PLAYBACK["Historical Playback & Timeline"]
        INVEST["Forensic Investigation & SHAP Panel"]
        AUDIO["Auditory Radar Layer\n(Web Audio API)"]
    end

    OSN --> INGEST
    SYNTH --> INGEST
    INGEST --> STREAM
    STREAM --> WORKER
    WORKER --> Pipeline
    Pipeline --> PG
    Pipeline --> REDIS
    REDIS --> WS
    PG --> REST
    PG --> PDF

    WS --> Frontend
    REST --> Frontend
```

---

## 🧠 Detection Pipeline Tiers

| Tier | Module | Method | Metrics Evaluated |
| :--- | :--- | :--- | :--- |
| **Tier 1** | **Kinematic Physics Rules** | Deterministic boundary validation | Ground speed ($\le 750\text{ kts}$), vertical speed ($\le 8,000\text{ ft/min}$), altitude steps ($\le 3,000\text{ ft/sec}$), geodesic distance jumps. |
| **Tier 2** | **Deep Autoencoder** | PyTorch 5-layer bottleneck network | Multivariate reconstruction residual ($L_2$ loss) over altitude, velocity, track, and vertical rate. |
| **Tier 3** | **Ensemble Classifier** | Soft-voting Random Forest + Gradient Boosting | Probabilistic spoofing classification with TreeSHAP feature importance ranking. |
| **Tier 4** | **Trust Decay Engine** | Bayesian historical EMA | Dynamic trust convergence with time-based degradation for stale or erratic observations. |

---

## ⚡ Getting Started

### Prerequisites

- **Python**: `3.11+`
- **Node.js**: `18.0+` (npm `9.0+`)
- **Docker & Docker Compose**: (Optional, for containerized run)
- **PostgreSQL**: `15+` (If running locally without Docker)
- **Redis**: `7+` or [Memurai for Windows](https://www.memurai.com) (If running locally without Docker)

---

### Option 1: Docker Compose (Recommended)

To build and run the entire AirGuard stack (PostgreSQL, Redis, FastAPI Backend, Telemetry Worker, and Nginx/Frontend):

1. **Clone the repository**:
   ```bash
   git clone https://github.com/YeSJ5/AirGuard.git
   cd AirGuard
   ```

2. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```

3. **Build and start services**:
   ```bash
   docker compose -f docker/docker-compose.yml up --build
   ```

4. **Access the application**:
   - **Frontend Dashboard**: [http://localhost:5173](http://localhost:5173)
   - **API Documentation (Swagger)**: [http://localhost:8001/docs](http://localhost:8001/docs)
   - **Prometheus Metrics**: [http://localhost:8001/metrics](http://localhost:8001/metrics)

---

### Option 2: Local Development Setup

#### 1. Backend Setup

```bash
# Navigate to repository root
cd AirGuard

# Create and activate Python virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install backend dependencies
python -m pip install -r requirements.txt

# Configure backend environment
cp backend/.env.example backend/.env

# Run database migrations
cd backend
alembic upgrade head

# Start FastAPI server
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload

# In a separate terminal, start the background telemetry worker
python -m app.worker
```

#### 2. Frontend Setup

```bash
# Navigate to frontend directory
cd frontend

# Install dependencies
npm install

# Start Vite development server
npm run dev
```

#### 3. Automated Windows Dev Launcher

On Windows with PowerShell, start all services (PostgreSQL migrations, Redis, FastAPI backend, Worker, and Vite) in one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\run_dev.ps1
```

---

## ⚙️ Environment Configuration

### Backend Configuration (`backend/.env` or root `.env`)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `DATABASE_URL` | Async PostgreSQL connection string | `postgresql+asyncpg://postgres:postgres@localhost:5432/airguard` |
| `REDIS_URL` | Redis connection URI for caching and streams | `redis://localhost:6379/0` |
| `OPENSKY_CLIENT_ID` | OpenSky Network OAuth2 client ID | `""` (Anonymous rate limits apply if empty) |
| `OPENSKY_CLIENT_SECRET` | OpenSky Network OAuth2 client secret | `""` |
| `SECRET_KEY` | JWT signing secret key | `supersecretkeychangeinproduction` |
| `ALGORITHM` | JWT token encryption algorithm | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Authentication token validity duration | `1440` (24 hours) |
| `INGESTION_INTERVAL_SECONDS` | Ingestion poll frequency | `10` |
| `SHOWCASE_MODE` | Populate realistic mock aircraft if feed empty | `true` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins | `http://localhost:5173,http://127.0.0.1:5173` |

### Frontend Configuration (`frontend/.env`)

| Variable | Description | Default |
| :--- | :--- | :--- |
| `VITE_API_URL` | Backend REST API base URL | `http://localhost:8001` |
| `VITE_WS_URL` | Backend WebSocket streaming URL | `ws://localhost:8001/api/v1/ws/airspace` |
| `VITE_CESIUM_ION_TOKEN` | Optional Cesium Ion access token for high-res terrain | `""` |

---

## 🛠️ Available Commands & Makefile

| Command | Description |
| :--- | :--- |
| `make dev` | Launches full local dev stack with migration checks and health verification |
| `make migrate` | Applies latest Alembic database migrations |
| `make test` | Runs backend pytest suite with async test runners |
| `make lint` | Runs Ruff & Black checks on Python and ESLint on TypeScript |
| `make train` | Executes the soft-voting ensemble ML training pipeline |

---

## 📡 API & Streaming Specifications

### REST Endpoints

- `GET /health`: Service health, database connection status, and Redis cluster connectivity.
- `GET /api/v1/aircraft`: List all active tracked aircraft with bounding box filters, trust scores, and telemetry status.
- `GET /api/v1/aircraft/{icao24}`: Detailed forensic breakdown of a single aircraft (transponder history, SHAP vector, trust metrics).
- `GET /api/v1/routes/{callsign}`: Retrieve departure, destination, estimated flight plan, and waypoints for a flight callsign.
- `GET /api/v1/events`: List detected airspace anomalies and security event candidate cases.
- `POST /api/v1/events/{event_id}/triage`: Update event triage status (Under Review, Confirmed Spoof, False Positive, Resolved).
- `GET /api/v1/reports/{icao24}/pdf`: Generate and download a formatted PDF forensic investigation report.
- `GET /metrics`: Prometheus formatted metrics for telemetry rates, detection latency, and trust scoring throughput.

### WebSocket Protocol

Connect to `ws://localhost:8001/api/v1/ws/airspace` to receive live airspace frames:

```json
{
  "type": "airspace_update",
  "timestamp": 1728108420.5,
  "count": 42,
  "aircraft": [
    {
      "icao24": "a1b2c3",
      "callsign": "AIC101",
      "origin_country": "India",
      "longitude": 77.1025,
      "latitude": 28.7041,
      "altitude": 10500.0,
      "velocity": 240.5,
      "heading": 180.0,
      "vertical_rate": -12.5,
      "trust_score": 0.94,
      "risk_level": "normal",
      "anomaly_flags": []
    }
  ]
}
```

---

## 📂 Project Structure

```
AirGuard/
├── backend/                        # Python 3.11 FastAPI Backend Service
│   ├── alembic/                    # Database migration version scripts
│   ├── app/
│   │   ├── api/                    # REST routers, dependencies & schemas
│   │   ├── core/                   # Configuration, Database & Redis clients
│   │   ├── detection/              # ML Models (Autoencoder, Ensemble, SHAP, Rules)
│   │   ├── ingestion/              # OpenSky Live Feed & Synthetic Ingestion
│   │   ├── tasks/                  # Data retention & scheduled cleanup
│   │   ├── models.py               # SQLAlchemy ORM models
│   │   ├── worker.py               # Redis Stream multi-replica worker
│   │   └── main.py                 # FastAPI application factory
│   ├── pyproject.toml              # Backend Poetry specifications
│   └── tests/                      # Automated unit and integration tests
│
├── frontend/                       # React 18 + Vite + TypeScript Dashboard
│   ├── public/                     # Static assets and icons
│   ├── src/
│   │   ├── components/             # 2D Radar, 3D Globe, Playback, and Threat Panels
│   │   ├── services/               # API clients, WebSocket & dead-reckoning motion
│   │   ├── store/                  # Zustand state management
│   │   ├── types/                  # TypeScript interface definitions
│   │   └── utils/                  # Coordinate transforms, audio synthesizer, and helpers
│   ├── package.json                # Frontend npm dependencies
│   └── vite.config.ts              # Vite + Cesium plugin bundler configuration
│
├── docker/                         # Multi-stage containerization files
│   ├── Dockerfile.backend          # Optimized Python backend image
│   ├── Dockerfile.frontend         # Nginx reverse proxy + React static build
│   ├── docker-compose.yml          # Full-stack composition
│   └── nginx.conf                  # Nginx edge proxy with WebSocket support
│
├── docs/                           # Architectural Decision Records (ADRs) & Model Cards
├── scripts/                        # Benchmarking, diagnostics, and test suites
├── requirements.txt                # Unified backend Python dependencies
├── run_dev.ps1                     # PowerShell development launcher
└── Makefile                        # Cross-platform development tasks
```

---

## 🧪 Testing & Quality Assurance

Run the comprehensive test suite and validation scripts:

```bash
# Run backend pytest suite with async test runners
cd backend
python -m pytest

# Run type check and linting
ruff check app tests
black --check app tests

# Run Locust load benchmark
locust -f scripts/locustfile.py --headless -u 100 -r 10 --run-time 1m --host http://127.0.0.1:8001
```

---

## ⚖️ License & Disclaimer

This project is developed for academic research, signal-quality verification education, and airspace monitoring experimentation. AirGuard is **not** an FAA/ICAO certified air traffic management system and must **not** be used as a primary means of aerial navigation.

Licensed under the [MIT License](LICENSE).
