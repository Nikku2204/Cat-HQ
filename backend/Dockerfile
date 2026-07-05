FROM python:3.12-slim

WORKDIR /app

# Dependency layer — keep in sync with pyproject.toml.
# Installed directly (not `pip install .`) so code changes don't re-download
# dependencies on every rebuild; this matters a lot on a small home box.
RUN pip install --no-cache-dir \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.30,<1" \
    "pydantic-settings>=2.4,<3"

COPY pyproject.toml ./
COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
