#!/bin/bash
# Replace the running Agentic City container with a given image tag.
#
# Installed to /usr/local/bin/redeploy.sh on the demo VM. Versioned here rather
# than typed into the VM, because the copy on the host silently drifted from the
# runbook: the host-network switch below existed only as an ad-hoc edit, which is
# exactly how the `-p` form survived three engine drops that could not work with it.
#
# WHY --network host AND NOT -p
#
# nsdeploy binds each site to 127.0.0.1 by default. With a bridged container and
# `-p 127.0.0.1:8100-8119:8100-8119`, Docker forwards the published port to the
# container's own interface, NOT its loopback — so a site bound to container
# loopback answers nothing, while the build still reports `ready`. The project
# worked around that with a local `--host` patch to nsdeploy, which three
# successive engine drops then removed, each time silently.
#
# Sharing the host's network namespace removes the problem instead of patching
# around it: a site on 127.0.0.1 inside the container IS on the host's loopback,
# which is where nginx already proxies. NSDEPLOY_SERVICE_DEPLOY_HOST stays at
# nsdeploy's own default, so no flag is needed and no engine drop can break it.
#
# The cost is network isolation: the container shares the host's namespace, so it
# can bind any host port and reach host-loopback services. Accepted here because
# this host already executes arbitrary uploaded Python by design. It also
# means NSDEPLOY_SERVICE_HOST must be 127.0.0.1, or the API would bind the VM's
# public-facing interface directly.
#
# Ports are therefore NOT published. nginx is the only public listener and reaches
# both the API (9000) and every site port over loopback.
set -e

TAG=${1:-latest}
IMG=${REGISTRY:-registry.example.com}/agentic-city:$TAG

docker pull "$IMG"
docker container stop agentic-city 2>/dev/null || true
docker container rm --force agentic-city 2>/dev/null || true

docker run -d --name agentic-city --restart unless-stopped \
  --network host \
  -v /data/nsdeploy:/app/.nsdeploy \
  --env-file /etc/agentic-city.env \
  "$IMG"
