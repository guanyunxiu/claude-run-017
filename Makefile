.PHONY: help up down build logs migrate seed test test-be test-e2e clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start the full stack (postgres, redis, minio, backend, frontend)
	docker compose up --build

down: ## Stop the stack
	docker compose down

build: ## Build all images
	docker compose build

logs: ## Tail all service logs
	docker compose logs -f

migrate: ## Apply Prisma migrations on the running backend
	docker compose exec backend npx prisma migrate deploy

seed: ## Seed demo users/project
	docker compose exec backend npm run seed

test: test-be test-e2e ## Run backend + e2e tests

test-be: ## Run backend unit/integration tests locally
	cd backend && npm test

test-e2e: ## Run two-browser Playwright E2E in Docker
	docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e

clean: ## Stop and remove volumes (DESTRUCTIVE)
	docker compose down -v
