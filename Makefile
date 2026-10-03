.PHONY: dev test lint train migrate

dev:
	@echo "Launching FastAPI backend and Vite React frontend..."
	# Launching in parallel windows for development convenience on Windows
	powershell -Command "Start-Process python -ArgumentList '-m uvicorn app.main:app --reload --port 8001' -WorkingDirectory backend; Start-Process npm -ArgumentList 'run dev' -WorkingDirectory frontend"

test:
	@echo "Running backend test suite..."
	cd backend && python -m pytest

lint:
	@echo "Checking backend ruff & black style..."
	cd backend && python -m ruff check app tests && python -m black --check app tests
	@echo "Checking frontend eslint style..."
	cd frontend && npm run lint

train:
	@echo "Running training pipeline..."
	cd backend && python scripts/train_ensemble.py

migrate:
	@echo "Running Alembic migrations..."
	cd backend && python -m alembic upgrade head

