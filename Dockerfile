FROM python:3.12-slim

WORKDIR /app

# pyproject.toml reads its dependencies from requirements.txt; without that file setuptools
# only warns and builds a wheel that declares no dependencies, so copy both.
COPY pyproject.toml requirements.txt ./
COPY nsdeploy ./nsdeploy
COPY nsdeploy_service ./nsdeploy_service
COPY examples ./examples

RUN pip install --no-cache-dir -e . && pip install --no-cache-dir -e ./nsdeploy_service

# Builds read HOCON includes, toolbox_info.hocon and coded tools from this copy of
# neuro-san-studio, not from the GitHub API, which allows 60 unauthenticated calls an hour.
ARG NEURO_SAN_STUDIO_REF=main
ADD https://github.com/cognizant-ai-lab/neuro-san-studio.git#${NEURO_SAN_STUDIO_REF} /opt/neuro-san-studio
ENV NSDEPLOY_SERVICE_STUDIO=/opt/neuro-san-studio

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
