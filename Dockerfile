FROM python:3.12-slim

# nsdeploy pip-installs a hosted tool's third-party deps on demand at build time.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pyproject.toml reads its dependencies from requirements.txt; without that file setuptools
# only warns and builds a wheel that declares no dependencies, so copy both.
COPY pyproject.toml requirements.txt ./
COPY nsdeploy ./nsdeploy
COPY nsdeploy_service ./nsdeploy_service
COPY examples ./examples

RUN pip install --no-cache-dir -e . && pip install --no-cache-dir -e ./nsdeploy_service

# Shown as "Build:" in the console header, like neuro-san-ui's NEXT_PUBLIC_NEURO_SAN_UI_VERSION.
ARG NSDEPLOY_SERVICE_BUILD_VERSION=""
ENV NSDEPLOY_SERVICE_BUILD_VERSION=${NSDEPLOY_SERVICE_BUILD_VERSION}

# No .env is baked in: credentials and settings come from container env vars, or
# NSDEPLOY_SERVICE_ENV_FILE pointing at a mounted file.

# Agentic City's own listener. The deployment port pool (5 ports, matching Azure
# Container Apps' additionalPortMappings limit) is set via NSDEPLOY_SERVICE_PORT_START/END
# at deploy time, not baked in here.
EXPOSE 9000

CMD ["python", "-m", "nsdeploy_service", "--host", "0.0.0.0"]
