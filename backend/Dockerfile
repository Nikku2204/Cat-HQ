# Build context is the REPO ROOT (docker-compose.yml sets context: . with
# dockerfile: backend/Dockerfile) so stage 1 can see frontend/ — the backend
# image serves the built PWA from app/static (one origin: REST + WS + UI).

# ── Stage 1: frontend build ──────────────────────────────────────────────
FROM node:26-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: backend ─────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Dependency layer — keep in sync with pyproject.toml.
# Installed directly (not `pip install .`) so code changes don't re-download
# dependencies on every rebuild; this matters a lot on a small home box.
RUN pip install --no-cache-dir \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.30,<1" \
    "pydantic-settings>=2.4,<3" \
    "pylitterbot==2025.6.1" \
    "aiohttp>=3.9,<4" \
    "sqlalchemy>=2.0,<3" \
    "aiosqlite>=0.20"

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY --from=frontend /fe/dist ./app/static

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
