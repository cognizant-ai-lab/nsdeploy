# Agentic City

Expose [nsdeploy](README.md) as an HTTP service: **POST an agent-network HOCON, get back
a live site URL.**

> **Naming.** *Agentic City* is the product name — it appears in the console, the
> OpenAPI docs, and the CLI banner, and it comes from `PRODUCT_NAME` in
> `nsdeploy_service/__init__.py`. It was *NS Deploy NexGen*; the Python package is
> still `nsdeploy_service` and settings are still `NSDEPLOY_SERVICE_*`, so the rename
> did not invalidate any existing deployment's imports or environment.

## Install

This folder is **self-contained and portable**. It needs no patches to nsdeploy. To
upgrade nsdeploy: replace everything else, drop this folder back in.

Deploying drives nsdeploy as a CLI (`python -m nsdeploy`), because a deployed site is
a process that has to outlive the request. Two modules import nsdeploy in process
instead, and say why in their own header: `themespec.py`, which restyles a built
bundle without a rebuild, and `bundler.py`, which builds a static bundle — a build
product with nothing to supervise. Both import at module level, so an upstream rename
is an ImportError at start-up rather than a failure during a request.

```
<nsdeploy checkout>/
  nsdeploy/              <- upstream, untouched
  pyproject.toml         <- upstream, untouched
  nsdeploy_service/      <- this folder: app, console, tests, docs,
                         |  and its own pyproject.toml
```

Drop the folder into the checkout root, then run one command:

```bash
python nsdeploy_service/bootstrap.py
```

It checks the placement, installs both packages, verifies the contract against the
nsdeploy it found, runs the test suite, and starts the service to confirm it answers
— then stops it. Exit 0 means ready.

**Expect the first run to take minutes, almost all of it in step 2.** nsdeploy's
dependency closure is ~99 packages — `neuro-san` brings langchain, openai and
tiktoken with it — so a cold install downloads a few hundred MB. The other five steps
total ~30s. Measured on an already-installed tree: install 74s, tests 17s,
connection 5s, everything else ~1s.

Two things make it quicker:

* **Install [uv](https://docs.astral.sh/uv/).** Bootstrap uses it automatically when
  it is on PATH, and it resolves the same tree several times faster. This repository
  already ships a `uv.lock`.
* **On a re-run, skip what you have already proved:**
  `python nsdeploy_service/bootstrap.py --skip-install --skip-tests` — about 7s.
  Bootstrap says so itself when a run passes 90s, and warns when both packages
  already point at this checkout (pip still spends ~35s each re-resolving nothing).

Every step prints its own elapsed time at the end, and the installer streams its
progress, so a slow step is distinguishable from a stuck one.

By hand, if you prefer:

```bash
pip install -e .                    # nsdeploy itself
pip install -e ./nsdeploy_service   # this service, from its own pyproject.toml
python -m nsdeploy_service --port 9100
```

The service declares its own dependencies, console scripts and packaging in
[`pyproject.toml`](pyproject.toml). Nothing about it lives in nsdeploy's
`pyproject.toml` any more — that file is replaced on every nsdeploy upgrade, and it
used to carry the `service` dependency extra, both console scripts *and*
`packages = [..., "nsdeploy_service"]`, so the first upgrade would have quietly left
the service uninstalled with no declared dependencies.

After every nsdeploy upgrade, the same one command re-verifies everything:

```bash
python nsdeploy_service/bootstrap.py
```

The check exists because two couplings fail *silently*: the service scrapes
nsdeploy's human-readable stdout for tool and agent names, and reads keys out of the
generated bundle. Reword a section header upstream and a network shows 0 agents and
no warnings while running perfectly.

Then open <http://127.0.0.1:9100/> for the deployment console, or
<http://127.0.0.1:9100/docs> for the generated OpenAPI docs.

The console offers **two choices: New network and Map.** It is built for people who are not
deploying software for a living, so the main path is one screen with two fields —
your organization name and a drag-and-drop zone — and one **Launch** button. The
organization is free text and is created on first use, so nobody has to register a
profile before their first upload.

Launch then opens a **progress dialog**: an agent network assembling itself while the
real build runs, three one-word steps, one line of what is happening right now, and a
clock. About eight words on screen — there is nothing to decide while you wait, so
there is nothing to read.

When the site answers, the dialog **closes itself** and takes you to the **network
map**, focused on what you just deployed: a full-screen cartographic view where each
network is a pin and an arrow is drawn wherever one network can actually call another.
Your new pin is announced, traced and haloed on arrival. Hover any pin to trace its
links; click it to open that network's site.

> The map opens in a **new tab** where the browser allows it. It often will not:
> browsers only permit `window.open` for a few seconds after a click, and a build
> takes about twenty — so the current tab is navigated instead. Either way you end up
> on your map, with nothing to click. Allow pop-ups for this origin if you want the
> new tab every time.

If a build fails, the dialog stays open and says why — a failed deployment has no
site, so there is no pin that could carry that message.

> **After changing anything under `ui/`, bump `?v=N` in [`ui/index.html`](ui/index.html).**
> A browser tab that was already open when you restarted the service never
> re-navigates, so it keeps running the JavaScript it booted with — which looks
> exactly like a broken console. The version is reported on `/health` as `ui_version`,
> and an open tab compares it with its own and offers a **Reload to update** bar. If
> the console ever seems not to respond to a click, hard-reload it first (Ctrl+Shift+R).

Everything else `POST /deployments` accepts (network name, TTL, BYOK upstream, CRUSE,
theming) comes from the service defaults rather than the screen — the API still takes
all of it for scripted callers. Stop, restart and remove live in the
Manage-deployments view, off the main path but one click away in the footer.

The map shows every organization and re-polls on the cadence the server advertises
(`MAP_REFRESH_SECONDS`, 1 minute by default) rather than anything set through the
UI — tracking a build is the launch dialog's job, not the map's. It lives in
[`nsdeploy_service/ui/`](ui/) — plain ES modules and CSS, no build step — and is
served same-origin from `/app/`. See [API_CONTRACT.md §9](API_CONTRACT.md) for its
structure and the seam where a login mechanism replaces the shared token.

```bash
# deploy and wait for the URL
id=$(curl -s -X POST http://127.0.0.1:9100/deployments \
       -F "file=@examples/travel_agent_system.hocon" \
       -F "org_name=Acme Logistics" | jq -r .id)
curl -s "http://127.0.0.1:9100/deployments/$id/wait?timeout=400" | jq '{status, url}'
# → { "status": "ready", "url": "http://127.0.0.1:8100" }
```

## How it works

One deployment is **one supervised `python -m nsdeploy` child process on its own port** —
the same model [`cailville/launch_all.sh`](cailville/launch_all.sh) already uses to run the
13-site demo. The service is a port allocator, process supervisor, and status API around
the existing CLI; `nsdeploy` itself is unmodified.

```
POST /deployments
  ├─ validate name + size, reserve a port from the pool, write <work>/<id>/<name>.hocon
  ├─ spawn: python -m nsdeploy <hocon> --port <p> --site-url <url> --out … --site-dir …
  ├─ poll until the port listens AND GET / returns 200        → status: ready
  └─ each deployment also owns: 1 FastMCP host per hostable tool + 1 public MCP facade
```

Three design constraints drove this shape, all of them properties of nsdeploy itself:

1. **A site owns a whole port.** `launcher.serve()` binds its own `ThreadingHTTPServer`
   and every generated route is root-absolute (`/_mcp/<i>/mcp`, `/v1`, `/byok/v1`, `/mcp`,
   `/runtime/*`). Sites cannot be multiplexed behind one listener on a path prefix, so
   `https://host/d/<id>/` routing will not work — use a port or a subdomain per deployment.
2. **`serve()` blocks and exposes no shutdown handle,** so it cannot be called in-process
   and later stopped. A child process can be killed; it also keeps a bad upload from
   taking the API down.
3. **The public origin is baked in at build time.** `--site-url` is written into
   `<net>.network.json`, `agent-manifest.json`, `.well-known/*`, the private-steward HOCON,
   and the MCP tool URLs. The URL must therefore be decided *before* generation — which is
   why the service allocates the port first and never rewrites the origin afterwards.

Builds are asynchronous because they are slow by nature: nsdeploy fetches the network's
includes and coded-tool sources from GitHub and may `pip install` a tool's dependencies
before it can serve. Expect **~20s warm**, considerably longer on a cold cache.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/orgs` | create an organization profile (`name` unique, plus `address`, `contact`) |
| `GET` | `/orgs` | list organizations with deployment counts |
| `GET` | `/directory` | every organization and the networks it deployed |
| `GET` | `/graph` | the same records as a network map: nodes, resolved links, and inferred relations |
| `GET` | `/relations` | relations between deployed networks, inferred from their descriptions (`strategy=heuristic\|llm`) |
| `POST` | `/deployments` | multipart upload (`file`, plus optional `org_id`, `org_name`, `name`, `upstream`, `theme`, `theme_model`, `cruse`, `ttl_seconds`) → `202`. `org_name` is created on first use |
| `POST` | `/deployments/raw?name=…` | same, with the HOCON as the raw request body |
| `GET` | `/deployments?org_id=…` | list all, plus pool capacity |
| `GET` | `/deployments/{id}` | poll one |
| `GET` | `/deployments/{id}/wait?timeout=600` | block until `ready`/`failed`; `504` + current state on timeout |
| `GET` | `/deployments/{id}/logs?tail=200` | nsdeploy's own build/serve output (`tail=0` for the whole log) |
| `POST` | `/deployments/{id}/restart` | relaunch a stopped/failed deployment from its stored HOCON, keeping its URL |
| `POST` | `/deployments/{id}/publish` | put a tested network on the map; `400` unless it is `ready` |
| `POST` | `/deployments/{id}/unpublish` | take it off the map; the deployment keeps running |
| `DELETE` | `/deployments/{id}?purge=false` | kill the process tree, free the port; `purge=true` also drops the record, and is refused while the deployment is live |
| `POST` | `/bundles` | multipart upload (`file`, plus optional `name`, `site_url`, `upstream`, `theme`, `theme_model`, `theme_refresh`, `theme_prompt`, `cruse`) → `200 application/gzip`. Builds a static bundle and returns it in the same request; nothing is kept |
| `POST` | `/bundles/raw?name=…` | same, with the HOCON as the raw request body |
| `GET` | `/health` | capacity, environment, warnings, console `ui_version` — unauthenticated for probes |

Statuses: `queued` → `building` → `ready`, or `failed` / `stopped`.
Full request/response contract: **[API_CONTRACT.md](API_CONTRACT.md)**.

A `ready` response carries the site's notable routes and what nsdeploy found in the
network:

```json
{
  "status": "ready",
  "url": "http://127.0.0.1:8100",
  "endpoints": {
    "site": "http://127.0.0.1:8100/",
    "mock_llm": "http://127.0.0.1:8100/v1/chat/completions",
    "byok_proxy": "http://127.0.0.1:8100/byok/v1/chat/completions",
    "mcp_facade": "http://127.0.0.1:8100/mcp"
  },
  "network": { "front_man": "travel_concierge_orchestrator", "agent_count": 10,
               "hostable_tools": ["ddgs_search", "wikimedia_media_search"] },
  "warnings": ["2 tool reference(s) could not be resolved and were dropped …"]
}
```

`warnings` are **not** failures — they surface the things nsdeploy reports that silently
degrade a deployed network: dropped unresolvable tools, `demo_mode` agents that fabricate
answers, and unlinked agent-network references.

## Launch, and it is on the map

Deploying puts a network on the map straight away. The console's whole flow is *type
your organization, drop a HOCON, press Launch* — and then it shows you the map, where
your pin is already sitting in a `building` state and turns live when the site
answers. Waiting for a separate publish step made a launch look like it had done
nothing for the ~20s of a warm build, which is the one moment a first-time user is
deciding whether the tool works.

So a record is published when it is **created**, and the map draws every published
deployment in `queued`, `building`, or `ready`:

- a `building` pin has no `url` yet, so it renders as pending rather than clickable;
- `failed` and `stopped` pins leave the map — a failed build has no site to open, and
  a stop is a deliberate withdrawal. The console reports a failed build in its launch
  banner, with the error, since there is no pin to carry it.

A network can still be taken off the map, and put back:

```bash
curl -X POST http://127.0.0.1:9100/deployments/$id/unpublish   # off the map
curl -X POST http://127.0.0.1:9100/deployments/$id/publish     # back on it
```

Only **map visibility** works this way. `/deployments`, `/directory` and `/relations`
list every record regardless, and each carries `published` / `published_at`. On
`/graph`, relations are computed over the drawn rows only: considering the others
would emit `suggested_edges` pointing at nodes the map does not contain. Removal
(`purge=true`) is still refused while a deployment is live — it discards the record,
the logs and the uploaded HOCON, so it must not double as a teardown.

The state survives everything a deployment does. Publishing is idempotent and keeps
its original timestamp; a restart, a stop, or a crash-and-reap leaves it alone, so a
relaunched network reappears without being published again.

### Keeping the draft workflow

`NSDEPLOY_SERVICE_AUTOPUBLISH=off` restores the older behaviour: a new deployment is a
*draft* that builds, serves, and is fully testable at its own URL but stays off the map
until its owner publishes it — and publishing then requires `ready`. That is the right
setting if the map has to be the estate someone vouched for rather than a record of
every launch, which matters because a network can come up `ready` while still reporting
dropped tools, `demo_mode` agents that fabricate answers, or unlinked references. The
console's Manage-deployments view offers **Publish** on any ready draft.

Networks deployed before the `published_at` column existed are adopted as published
when it is created, so nothing already on the map disappears. That adoption runs once,
at migration time — not on every start-up, which would republish every draft that
happened to be ready.

## Inferred relations between networks

Deployed networks are independent — nothing connects them unless somebody binds one to
another. To make the shape of a multi-network deployment visible without that,
[`relations.py`](nsdeploy_service/relations.py) infers relations from what each network
says about itself. It is the Cailville idea
([`infer_profile`](nsdeploy/cailville.py)) generalised: Cailville scores a new site
against a fixed town of thirteen hand-authored peers, with per-site tuning that does
not survive arbitrary uploads, so the scoring is rebuilt rather than imported.

Two signals, kept apart because they mean different things:

- **capability** — the consumer declares an unfilled `link_slot` whose name matches what
  the provider does. Directional and grounded in structure: one side states a hole, the
  other looks able to fill it. Always outranks affinity.
- **affinity** — the two networks simply write about the same things. Symmetric and
  weaker: high affinity between two order-management orchestrators means they are
  *alternatives*, not collaborators.

Terms are weighted by smoothed inverse document frequency over the deployed set, so
vocabulary every network shares — the injected CRUSE directive, "agent", "request" —
earns almost nothing. That is why the scorer needs no knowledge of what nsdeploy injects
into instructions.

**Suggestions are never applied.** They surface as `suggested_edges` on `/graph`, kept
separate from `edges` (real, resolved links) so the map cannot present a guess as a
wired connection. Nothing writes an inferred relation into a site's `links.json`, where
it would be served to every visitor as though a human had chosen it.

`/graph` is polled on a timer and therefore always uses the deterministic scorer.
`GET /relations?strategy=llm` is the deliberate one-off that asks a model, and falls
back to the scorer on any failure — so the feature never depends on a key.

A deployed site needs **no API key**: it runs on nsdeploy's deterministic mock LLM at
`/v1`. Real output is BYOK — the visitor enters their own key in the page's ⚙ settings and
it routes through that site's `/byok/v1` to `--upstream`. The service never holds a key.

## Configuration

Flags on `python -m nsdeploy_service`, or `NSDEPLOY_SERVICE_*` environment variables for
everything (see [config.py](nsdeploy_service/config.py)).

| Setting | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `9000` | the API's own listener |
| `DEPLOY_HOST` | `127.0.0.1` | address each deployed site binds (`nsdeploy --host`). **Leave at loopback** — run the container with `--network host`, or set `SUBDOMAIN_TEMPLATE`. Anything else needs `--host`, which upstream nsdeploy does not ship; the service probes for it and refuses the deployment rather than serving nothing |
| `PORT_START` / `PORT_END` | `8100` / `8199` | deployment port pool; must not contain `PORT` |
| `PUBLIC_SCHEME` / `PUBLIC_HOST` | `http` / `127.0.0.1` | how the returned URL is spelled |
| `SUBDOMAIN_TEMPLATE` | *(empty)* | e.g. `{id}` → `https://<id>.example.com`, no port in the URL |
| `WORK_ROOT` | `.nsdeploy/service` | per-deployment HOCON, bundle, and log |
| `DB_PATH` | `<work_root>/service.db` | SQLite file holding organizations and deployment records |
| `UI_DIR` | `nsdeploy_service/ui` | the console's static files; point elsewhere to serve it from a CDN |
| `UPSTREAM` | `https://api.openai.com/v1` | each site's BYOK proxy target |
| `STUDIO` | *(empty)* | local neuro-san-studio checkout; avoids per-build GitHub fetches |
| `THEME` | `off` | deploy-time LLM theming; needs `OPENAI_API_KEY` and adds minutes |
| `AUTOPUBLISH` | `on` | put a new deployment on the map the moment it is created; `off` restores the draft → publish workflow |
| `TTL_SECONDS` | `0` | auto-stop after N seconds; `0` (the default) keeps deployments up until stopped |
| `MAX_DEPLOYMENTS` | `60` | live ceiling; must be <= the port pool, and <= the map grid (88 slots) or pins stack |
| `MAX_CONCURRENT_BUILDS` | `2` | throttles GitHub fetches and `pip install`s |
| `BUILD_TIMEOUT_SECONDS` | `600` | readiness deadline |
| `MAX_HOCON_BYTES` | `524288` | upload cap |
| `MAP_REFRESH_SECONDS` | `60` | how often the Map tab re-polls `/graph`; the console never waits longer than 60s |
| `RELATIONS_MAX_PER_NETWORK` | `4` | most inferred relations suggested per network |
| `RELATIONS_LLM` | `off` | let `GET /relations?strategy=llm` ask a model; needs `OPENAI_API_KEY` |
| `RELATIONS_MODEL` | `gpt-4o` | model used when `RELATIONS_LLM` is on |
| `MAX_CONCURRENT_BUNDLE_BUILDS` | `4` | bounds `POST /bundles`, separately from deployments so a bundle never queues behind a cold build |
| `API_TOKEN` | *(empty)* | when set, every route except `/health` needs `Authorization: Bearer …` |
| `CORS_ORIGINS` | *(empty)* | comma-separated origins allowed to call this API from a browser on another host, e.g. `https://app.example.com,http://127.0.0.1:5173`. Empty sends no CORS headers at all. Each entry is `scheme://host[:port]` with no path; `*` allows any origin and is only safe with `API_TOKEN` set |
| `ENV_FILE` | `<repo root>/.env` | where credentials are read from and `POST /settings` writes; put it on a volume in a container, or saved settings are lost on restart |

**Deployments are long-lived and records are persisted.** Organizations, deployment
records, the uploaded HOCON, and the options chosen for it all persist, so the directory
survives a restart. The deployed sites do not — they are child processes of the service —
so on start-up any record still marked live is reconciled to `stopped` with its URL
cleared and its port released. That way the directory never advertises a URL that answers
nothing.

Nothing relaunches automatically, but every stopped or failed row has a **Restart**
button in the console (`POST /deployments/{id}/restart`). It rebuilds from the stored
HOCON, replays the original options, and asks for the original port back — so the site's
URL normally survives the round trip. It fails with a clear message only if the work
directory was cleaned and the HOCON is gone.

## Tests

```bash
python -m unittest discover -s nsdeploy_service/tests -t .   # the service, no network
python -m unittest discover -s tests                          # nsdeploy's own tests
```

## Deploying on Azure

Two things were code problems and are fixed; the rest is configuration and one
architectural constraint that no setting can remove.

**Fixed in code.** Each site's listener is now `DEPLOY_HOST` (`nsdeploy --host`)
instead of a hardcoded `127.0.0.1`, so a container can publish it, and the readiness
probe follows that address. TLS trust is configured automatically by
[`nsdeploy/certs.py`](nsdeploy/certs.py) when the interpreter has no CA store, so a
slim base image cannot fail every GitHub fetch with CERTIFICATE_VERIFY_FAILED.

**The constraint: one deployment owns one port.** `launcher.serve()` binds its own
listener and every generated route is root-absolute (`/_mcp/<i>/mcp`, `/v1`,
`/byok/v1`, `/mcp`, `/runtime/*`), and the public origin is baked into the bundle at
build time. So sites cannot be multiplexed behind one listener on a path prefix.

That rules out **both Azure App Service and Azure Container Apps** for the deployed
sites. Both publish a single port through their ingress, so `https://<app-fqdn>:8100`
does not resolve — and because the origin is baked into the bundle, the deployment
still comes up `ready` while its URL answers nothing. `/health` warns when the
configuration would produce such a URL.

Use a host where the **whole port range is reachable**:

* an **Azure VM / VMSS** with an NSG opening the API port and the pool, or
* **Azure Container Instances**, which can expose a list of ports — narrow the pool
  to match (`PORT_START=8100`, `PORT_END=8109`, `MAX_DEPLOYMENTS=10`).

```bash
NSDEPLOY_SERVICE_HOST=0.0.0.0                 # the API itself
NSDEPLOY_SERVICE_DEPLOY_HOST=0.0.0.0          # each deployed site
# http, not https: nothing terminates TLS on ports 8100-8199, and `https` there
# fails exactly the way a single-port ingress does.
NSDEPLOY_SERVICE_PUBLIC_SCHEME=http
NSDEPLOY_SERVICE_PUBLIC_HOST=<vm-public-dns-or-ip>
NSDEPLOY_SERVICE_PORT_START=8100
NSDEPLOY_SERVICE_PORT_END=8199
NSDEPLOY_SERVICE_MAX_DEPLOYMENTS=20           # must be <= the pool size
NSDEPLOY_SERVICE_API_TOKEN=<a real secret>    # otherwise every route is open
NSDEPLOY_SERVICE_WORK_ROOT=/data/work         # persistent volume
NSDEPLOY_SERVICE_DB_PATH=/data/service.db     # persistent volume
NSDEPLOY_SERVICE_STUDIO=/opt/neuro-san-studio # avoid per-build GitHub egress
```

### A hostname per deployment, behind one port

A browser origin is scheme + host + **port** — so a hostname per deployment gives
each site its own origin and the bundle's root-absolute paths resolve. The port was
never the requirement; a distinct origin was. That makes a single-port ingress work.

Set `SUBDOMAIN_TEMPLATE` and [`siteproxy.py`](nsdeploy_service/siteproxy.py) routes
each hostname to that deployment's loopback port:

```bash
NSDEPLOY_SERVICE_PUBLIC_SCHEME=https
NSDEPLOY_SERVICE_PUBLIC_HOST=agents.example.com
NSDEPLOY_SERVICE_SUBDOMAIN_TEMPLATE='{slug}-{id}'
# -> https://bank-kyc-end-to-end-c2a3a18ee383.agents.example.com
```

Placeholders: `{slug}` (the network name as a DNS label), `{id}` (12 hex chars),
`{name}` (alias for slug), `{port}`. **Use `{slug}-{id}`, not `{slug}` alone** —
network names are not unique, so a slug-only hostname collides between two
deployments of the same network. The slug is capped at 40 characters so the id
always survives inside the 63-character DNS label.

Requires a **wildcard DNS record** and certificate for `*.agents.example.com`. On
Container Apps, front it with **Azure Front Door**: it terminates TLS for the
wildcard, rewrites `Host` to the container app's own FQDN so ingress accepts the
request, and preserves the caller's hostname in `X-Forwarded-Host`, which the proxy
reads in preference to `Host`. Behind an nginx/Caddy that passes `Host` through, the
same build works unchanged.

The site processes stay on loopback — they are never directly reachable — and the
proxy route is deliberately **unauthenticated**, because published sites are public
while the management API stays behind `API_TOKEN`. Site traffic flows through the
service process, so it becomes a throughput bottleneck and a single point of failure
for the sites as well as the API.

The remaining alternative, if you want per-site isolation as well, is giving each
deployment **its own Container App** — replace `Supervisor._spawn`, the single seam,
with an Azure API call. That also contains the arbitrary-code-execution exposure.

**Already deployed sites must be rebuilt, not restarted**, after changing any
`PUBLIC_*` value: the old origin is inside the existing bundle.

`PUBLIC_*` must spell the origin the browser will actually reach: it is written into
`<net>.network.json`, `agent-manifest.json`, `.well-known/*`, the MCP tool URLs and
the steward HOCON, and cannot be rewritten afterwards.

**Credentials.** If the container cannot read `.env`, `Settings` falls back to its
defaults *silently*: `THEME` off and no `OPENAI_API_KEY` means every site builds with
the default look (nsdeploy prints `--theme set but no key … using the default look`)
and an empty `API_TOKEN` leaves every route open. Nothing fails loudly, so this is
easy to mistake for a theming bug. Three ways to supply them, best first:

1. **Container env vars.** Nothing on disk, nothing in a layer. `load_into_environ()`
   uses `setdefault`, so these always win over any file.
2. **`ENV_FILE` on a mounted volume.** The only option where a credential saved in
   the UI survives a restart — both the console's ⚙ dialog (`POST /settings`) and
   the admin panel's keys screen write this file. Without it the save appears to
   succeed (the response reflects the in-memory update) then reverts on the next
   revision. The admin panel also keeps its own encrypted copy in `admin.db`, so
   put that on the volume too via `WORK_ROOT`.
3. **`.env` baked into the image**, at the repo root or `nsdeploy_service/.env`
   (that directory is already `COPY`'d, so it needs no Dockerfile change — but it is
   copied *before* `pip install`, so editing it invalidates the dependency layer and
   slows rebuilds; the root copy is `COPY`'d after, and does not). Acceptable only
   for a private image: the key stays recoverable from layer history even if a later
   layer deletes it. If the image ever reaches a shared registry, rotate.

**Persistence.** `WORK_ROOT` and `DB_PATH` must be on a mounted volume. The records
survive a restart but the sites do not — they are child processes — so on boot every
live record reconciles to `stopped` and needs **Restart**. On ephemeral storage the
uploaded HOCON is lost too, and then even Restart cannot rebuild it.

**Egress.** A cold build fetches from `api.github.com` and
`raw.githubusercontent.com` and may `pip install` a tool's dependencies. Either
allow that egress or pre-seed `STUDIO` (or a warm `~/.cache/nsdeploy`) into the
image, which is faster and removes the dependency on GitHub at request time.

**Still open before this faces anyone else:** the arbitrary-code-execution problem
below. An uploaded HOCON runs as the service, and on Azure that identity may hold a
managed identity or mounted secrets. Isolate each deployment before accepting
uploads from anyone you do not trust.

## Before hosting this

The local defaults are safe **only because they are on loopback**. One thing must be
settled before this is reachable by anyone else:

> **An uploaded HOCON is arbitrary code execution.** nsdeploy resolves a network by
> importing the Python classes it names and `pip install`ing their missing dependencies
> ([`resolve.py::_import_with_autoinstall`](nsdeploy/resolve.py#L299), with
> `AUTO_INSTALL_TOOL_DEPS = True` as a module constant and no environment override). Tool
> subprocesses also inherit the full host environment — a gap nsdeploy itself flags at
> [`launcher.py:441-443`](nsdeploy/launcher.py#L441-L443). Accepting uploads from untrusted
> callers therefore means running untrusted code with the service's privileges.

So the hosted phase is a containerisation and routing exercise, roughly:

1. **Isolate each deployment** in its own container with a scrubbed environment (no host
   provider credentials), a read-only base image, CPU/memory caps, and an egress policy.
   The supervisor's spawn seam is a single method — [`Supervisor._spawn`](nsdeploy_service/supervisor.py) —
   so swapping `subprocess.Popen` for a container run is a contained change.
2. **Route by subdomain, not path.** Set `SUBDOMAIN_TEMPLATE` and `PUBLIC_HOST` and put a
   reverse proxy in front mapping `<id>.host` → the private port. Path prefixes break the
   generated bundle's root-absolute routes.
3. **Bind the site off-loopback or proxy locally.** `launcher.serve()` hardcodes
   `127.0.0.1` ([launcher.py:500](nsdeploy/launcher.py#L500)); either keep the proxy on the
   same host or add a `--host` argument to nsdeploy.
4. **Replace the shared token with real per-user auth** and enable TLS at the proxy.
   Organization profiles are attribution labels today: one `API_TOKEN` means any caller
   can stop any organization's deployments. The UI's swap point is
   [`ui/assets/js/api/auth.js`](ui/assets/js/api/auth.js); the server's is the
   `require_token` dependency in [app.py](nsdeploy_service/app.py).
5. **Move SQLite to a durable volume** (`DB_PATH`), or to Postgres if several service
   instances ever share a registry — the current store assumes one writer.
6. **Pre-seed the studio cache** (`STUDIO`, or a warm `~/.cache/nsdeploy`) in the image so
   builds stop depending on GitHub at request time.
7. **Decide whether reconciled deployments should be re-launched on boot.** Today records
   survive a restart but the sites do not, so an org's URL goes dark until someone
   redeploys.
