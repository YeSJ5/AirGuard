.PHONY: dev test lint train migrate

dev:
	@echo "Launching FastAPI backend and Vite React frontend..."
	# Launching in parallel windows for development convenience on Windows
	powershell -Command "Start-Process poetry -ArgumentList 'run uvicorn app.main:app --reload --port 8001' -WorkingDirectory backend; Start-Process npm -ArgumentList 'run dev' -WorkingDirectory frontend"

test:
	@echo "Running backend test suite..."
	cd backend && poetry run pytest

lint:
	@echo "Checking backend ruff & black style..."
	cd backend && poetry run ruff check app tests && poetry run black --check app tests
	@echo "Checking frontend eslint style..."
	cd frontend && npm run lint

train:
	@echo "Running training pipeline..."
	cd backend && poetry run python scripts/train_ensemble.py

migrate:
	@echo "Running Alembic migrations..."
	cd backend && poetry run alembic upgrade head
