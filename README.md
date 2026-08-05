# AirGuard Monorepo

![Coverage](https://img.shields.io/badge/Coverage-85%25-brightgreen)

AirGuard is a real-time ADS-B trust-scoring ground station. This repository is organized as a monorepo containing the backend service, frontend dashboard, training/utility scripts, containerization config, and CI setup.

## Getting Started

Set up and launch the entire AirGuard stack (PostgreSQL database, FastAPI backend, background ingestion/detection loops, and the React frontend dashboard) in three simple steps:

1. **Clone the Repository**:
   ```bash
   git clone <repository-url> && cd airguard-monorepo
   ```

2. **Initialize Environment Configuration**:
   ```bash
   cp .env.example .env
   ```

3. **Launch the Containerized Stack**:
   ```bash
   docker compose -f docker/docker-compose.yml up --build
   ```
   *This command spins up the database, automatically applies Alembic migrations, starts the backend API/ingestion tasks, and serves the frontend dashboard at `http://localhost:5173`.*

## Project Structure
- `/backend`: Python 3.11 service running FastAPI, Poetry, and background pipelines. Configured with slowapi rate-limiting, database connectors (sqlalchemy/asyncpg), and machine learning packages (scikit-learn/PyTorch).
- `/frontend`: React 18 dashboard built on Vite + TS + Tailwind CSS. Features custom radar metrics visualizers, anomaly panels, and state management via Zustand.
- `/scripts`: Python pipelines for anomaly injection, model training, and report exporting.
- `/docker`: Dockerfiles and Docker Compose configuration.
- `/.github/workflows`: CI/CD pipelines.
- `/docs`: Architecture Decision Records (ADR), Model Card details, and Demo Scripts.

## Quick Start Command Line Interface
Coordinate tasks using the root `Makefile`:

- **Run Dev Servers (Local Mode)**:
  ```bash
  make dev
  ```
  *Launches local FastAPI backend (`http://localhost:8001`) and Vite frontend (`http://localhost:5173`) concurrently.*

- **Run Database Migrations (Local Mode)**:
  ```bash
  make migrate
  ```
  *Executes Alembic migrations to align database schema.*

- **Execute Tests**:
  ```bash
  make test
  ```
  *Runs the backend pytest suite.*

- **Lint Codebase**:
  ```bash
  make lint
  ```
  *Checks Python style with Ruff & Black, and TypeScript/React style with ESLint.*

- **Train Machine Learning Model**:
  ```bash
  make train
  ```
  *Executes the soft-voting ensemble RF+GB training pipeline.*

## Running in VSCode
You can run and debug the entire stack directly in VSCode:
1. Open the project root folder (`f:/major_project`) in VSCode.
2. Open the **Run and Debug** view (`Ctrl+Shift+D`).
3. Select **`AirGuard: Launch Stack`** and press **F5**.
   *This starts the frontend task and attaches the debugger to the FastAPI backend dynamically.*

## Manual Script Commands
- **Inject Anomalies (narration mode)**:
  ```bash
  python scripts/inject_anomaly.py --type position_jump
  ```
- **Inject Anomalies (batch script demo)**:
  ```bash
  python scripts/inject_anomaly.py --batch
  ```
