FROM python:3.12-slim-trixie AS api

# pg_dump must match the server's major version (18) for pre-migration dumps, so use PGDG's client.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY migrations ./migrations

ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
EXPOSE 8000
# Migrations run before the server starts; a failed migration stops the container (PLAN.md §4).
CMD ["sh", "-c", "python -m app.migrate && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers"]


# Region data setup (PLAN.md §4): the same code plus osmium and the pmtiles CLI.
FROM api AS setup
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl \
 && rm -rf /var/lib/apt/lists/* \
 && arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x86_64) \
 && url=$(curl -fsSL https://api.github.com/repos/protomaps/go-pmtiles/releases/latest \
          | grep -o "https://[^\"]*_Linux_${arch}\.tar\.gz" | head -1) \
 && curl -fsSL "$url" | tar -xz -C /usr/local/bin pmtiles \
 && pmtiles version
CMD ["python", "-m", "app.setup"]
