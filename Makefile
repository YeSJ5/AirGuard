.PHONY: dev test lint train migrate

dev:
	@echo "Launching AirGuard with database migrations and service health checks..."
	powershell -NoProfile -ExecutionPolicy Bypass -File .\run_dev.ps1

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

