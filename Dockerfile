FROM python:3.11-slim

# nsdeploy pip-installs a hosted tool's third-party deps on demand at build time.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY nsdeploy ./nsdeploy
COPY nsdeploy_service ./nsdeploy_service
COPY examples ./examples

RUN pip install --no-cache-dir -e . && pip install --no-cache-dir -e ./nsdeploy_service

# Credentials. envfile.py reads REPO_ROOT/.env, which is /app/.env here, and
# load_into_environ() seeds os.environ from it with setdefault — so a container env
# var of the same name still wins, and this is only the fallback. Without it the
# service starts on its defaults (THEME off, no OPENAI_API_KEY) and every site is
# built with the default look.
#
# Baking a secret into a layer is only acceptable because this image is private.
# If it ever reaches a shared registry, rotate the key and move these to container
# env vars or NSDEPLOY_SERVICE_ENV_FILE on a mounted volume instead.
#
# Copied after the install so editing .env does not invalidate the pip layer.
# pyproject.toml is named again purely to anchor the glob: a wildcard matching
# nothing is a build error, so this keeps the build working when .env is absent.
COPY pyproject.toml .env* ./

# Agentic City's own listener. The deployment port pool (5 ports, matching Azure
# Container Apps' additionalPortMappings limit) is set via NSDEPLOY_SERVICE_PORT_START/END
# at deploy time, not baked in here.
EXPOSE 9000

CMD ["python", "-m", "nsdeploy_service", "--host", "0.0.0.0"]
