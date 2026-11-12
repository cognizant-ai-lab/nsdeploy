# Agentic City — API contract

Base URL (local): `http://127.0.0.1:9100`
Machine-readable schema: `GET /openapi.json` · interactive: `GET /docs`

All payloads are `application/json` unless stated. Timestamps are **UTC ISO-8601 to
second precision** (`2026-09-22T20:29:19+00:00`). All times are server-generated.

---

## 1. Authentication

<!-- pyml disable md013 -->
| Condition | Behaviour |
| --- | --- |
| `API_TOKEN` unset (default) | every route is open — intended for loopback only |
| `API_TOKEN` set | `Authorization: Bearer <token>` required on all routes **except** `GET /health` and the UI's static assets |
| `API_TOKEN` and `CONSOLE_PROXY` set | as above, except the console's own requests under `/console-api` (below), which the server sends with the token |
<!-- pyml enable md013 -->

Failure: `401` `{"detail": "a valid bearer token is required"}` — returned both for a
missing header and a wrong token (no distinction, by design).

The token is **shared, not per-user**: it authenticates the caller as "someone allowed to
use this service", not as a particular organization. Anyone holding it can stop any
organization's deployments. Per-org isolation requires the login mechanism.

The UI's assets are served unauthenticated (they are static files and carry no data),
but every call it makes is gated. On a `401` it prompts for the token once and keeps it
in `sessionStorage` for the tab.

### The console proxy (`/console-api`)

The console sends every request to `/console-api/<path>`, except `POST /settings`, which
goes to `/settings`. `/console-api/<path>` serves `/<path>`.

With `CONSOLE_PROXY` off (the default), that is all it does: the request needs the token
and gets CORS exactly as `/<path>` does.

With `CONSOLE_PROXY` on, the server replaces the request's `Authorization` with
`Bearer <API_TOKEN>`, so the console never asks for the token. **Anyone who can reach the
service can then make these requests**, including uploading a network, which runs code
on the host. Start-up and `/health` warn while it is on. Only these requests are passed
on:

```text
GET    /health  /settings  /orgs  /graph  /directory  /deployments  /deployments/{id}
GET    /deployments/{id}/wait|logs|graph|theme-spec
POST   /orgs  /deployments  /deployments/{id}/restart|theme|theme-spec|publish|unpublish
PATCH  /orgs/{id}
DELETE /orgs/{id}  /deployments/{id}
```

Everything else under `/console-api` gets
`403` `{"detail": "<method> <path> isn't a console request"}`, so `POST /settings`,
`/bundles` and the other routes still need the caller's own token. A request whose
`Sec-Fetch-Site` is not `same-origin` or `none`, or, without `Sec-Fetch-Site`, whose
`Origin` matches neither the first `X-Forwarded-Host` entry nor `Host`, gets `403`
`{"detail": "/console-api refuses requests from another site"}`, so another page cannot
use a visitor's browser to make them, CORS preflights included.
`GET /console-api/settings` returns an empty `last4` for every key.

### Cross-origin callers (CORS)

Off by default. With `CORS_ORIGINS` empty the service sends no `Access-Control-*`
headers at all, which is right for the console: it is served from this same origin
(§9), so nothing cross-origin is involved.

Set `CORS_ORIGINS` to a comma-separated list for a client served from somewhere else —
a browser app in another deployment that calls `POST /bundles`, for example.

<!-- pyml disable md013 -->
| Setting | Behaviour |
| --- | --- |
| `CORS_ORIGINS` unset (default) | no CORS headers; a cross-origin page cannot read any response |
| `CORS_ORIGINS=https://app.example.com` | that origin may call every route |
| `CORS_ORIGINS=*` | any origin may call every route — **only safe with `API_TOKEN` set**, and `/health` warns when it is not |
<!-- pyml enable md013 -->

Each entry is an origin and nothing else: `scheme://host[:port]`, no path, no wildcard
host. That is literally what a browser puts in the `Origin` header and the match is
exact, so anything else can never fire; the service refuses it at start-up rather than
letting it look like a server fault later. A trailing `/` is tolerated and stripped.

**Credentials are never allowed.** This API authenticates with a bearer header, never a
cookie, so there is nothing for a browser to attach on its own. `Authorization` and
`Content-Type` are the accepted request headers, and preflights are cached for 600s.

**A `401` still carries the CORS headers**, so a cross-origin client can read it and
prompt for a token — the same flow the console uses.

Only these response headers are readable cross-origin; a browser hides every other one:

```text
Location  Content-Disposition  X-Bundle-Name  X-Bundle-Files
X-Bundle-Unpacked-Bytes  X-Bundle-Sha256  X-Bundle-Warnings
```

### Surfaces

| Path | What |
| --- | --- |
| `GET /` | `307` → `/app/` |
| `GET /app/` | the deployment console (see §9) |
| `GET /console` | dependency-free fallback console, for debugging without the UI assets |
| `GET /docs`, `GET /openapi.json` | interactive and machine-readable schema |

---

## 2. Resource lifecycle

```text
POST /deployments ──▶ queued ──▶ building ──▶ ready
                         │           │          │
                         └───────────┴──▶ failed│   (build error / timeout / crash)
                                                └──▶ stopped   (DELETE, TTL, shutdown)
                            ▲                          │
                            └──────────────────────────┘
                              POST /deployments/{id}/restart
```

| Status | `url` | `port` | Meaning |
| --- | --- | --- | --- |
| `queued` | `null` | reserved | accepted; waiting for a build slot (`MAX_CONCURRENT_BUILDS`) |
| `building` | `null` | reserved | nsdeploy is resolving and generating; nothing listening yet |
| `ready` | **set** | set | the site answered HTTP 200; `endpoints` and `network` populated |
| `failed` | `null` | `null` | see `error`; port released |
| `stopped` | `null` | `null` | torn down; port released |

`ready` → `failed` is possible after the fact: if a running site's process dies, the
background reaper (every `REAP_INTERVAL_SECONDS`, default 30s) marks it `failed`.

**`failed` and `stopped` are recoverable, not final.** Both are retained in the registry
with their `error` and logs intact, and either can be relaunched in place with
`POST /deployments/{id}/restart` (§4.7) as long as the uploaded HOCON is still in the
work directory. Nothing restarts automatically.

**Records are persisted; processes are not.** Organizations and deployment records live
in SQLite and survive a restart. The deployed sites do not — they are child processes of
the service. On start-up every record still marked `queued`/`building`/`ready` is
reconciled to `stopped` with
`error: "the deployment did not survive a service restart"`, its `url`/`port`/`pid`
cleared, and its port released. The directory therefore never advertises a URL that
answers nothing. `/health` reports how many were reconciled. Build logs remain readable
after a restart because the log path is persisted.

Those reconciled records are exactly what `POST /deployments/{id}/restart` is for: the
HOCON and the chosen options are persisted too, so bringing a site back after a service
restart is one call and normally returns the same URL.

`DELETE` stops a deployment but keeps the record. Add `?purge=true` to stop it *and*
remove the record from the directory.

---

## 3. Organizations

An organization is a **label for attribution, not a credential**. With one shared
`API_TOKEN`, any caller can act on any organization's deployments. Real per-org
isolation needs the login mechanism, not this model.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/orgs` | `{name, address?, contact?}` → `201` `OrgView`. `409` if the name exists |
| `GET` | `/orgs` | `{organizations: [OrgView]}`, newest first, with counts |
| `GET` | `/orgs/{id}` | one; `404` if unknown |
| `PATCH` | `/orgs/{id}` | any of `name`/`address`/`contact`; `409` on a name clash |
| `DELETE` | `/orgs/{id}` | `204`. **`409` while it still owns deployment records** |
| `GET` | `/orgs/{id}/deployments` | same shape as `GET /deployments` |

Names are unique **case- and whitespace-insensitively** — `Acme`, `acme`, and
a padded `ACME` collide. `name` is required, ≤120 chars; `address` ≤500; `contact` ≤200.

`OrgView`: `id`, `name`, `address`, `contact`, `created_at`, `deployment_count`,
`live_count` (queued + building + ready).

A deployment can name its organization two ways, and `POST /deployments` accepts both:

<!-- pyml disable md013 -->
| Field | Behaviour |
| --- | --- |
| `org_id` | must already exist; `400` if not. Takes precedence over `org_name` |
| `org_name` | **get-or-create**: matched case- and whitespace-insensitively against existing organizations, created on first use. `400` if the name is unusable (blank after trimming falls back rather than creating a nameless org) |
<!-- pyml enable md013 -->

`org_name` is what the console sends, so an operator types their organization once
instead of creating a profile and then picking its id. An unknown `org_id` is an error
rather than a silent re-attribution: a caller naming a specific organization that has
been deleted should hear about it, not have their network quietly filed under
`Unattributed`.

A deployment with neither is attributed to a seeded organization named
**`Unattributed`**, so the directory is always complete. That organization is created
on first start and behaves like any other.

### `GET /directory`

The shared catalogue — every organization with the networks it deployed.

| Param | Default | Notes |
| --- | --- | --- |
| `live_only` | `false` | hide `stopped` and `failed` records |

```json
{
  "organizations": [
    { "organization": { "id": "…", "name": "Acme Logistics", … },
      "deployments": [ DeploymentView, … ] }
  ],
  "totals": { "organizations": 2, "deployments": 1, "ready": 1 }
}
```

Organizations with no deployments are still listed (with an empty array) unless
`live_only` filters them out client-side.

### `GET /graph`

The same registry as a network map: deployed networks as nodes, the links between
them as edges. A pure read projection — it never alters a deployment.

| Param | Default | Notes |
| --- | --- | --- |
| `org_id` | *(all)* | filter to one organization; `404` if unknown |
| `live_only` | `false` | accepted for compatibility; subsumed by the status rule below |

**Which deployments are drawn.** A node appears when it is **published** *and* its
status is `queued`, `building`, or `ready`.

- `queued`/`building` qualify so a pin exists from the moment a network is launched
  and fills in as the build completes — with `AUTOPUBLISH` on (the default) that is
  immediately. Such a node has `url: null` and an empty `network` summary, so
  `agent_count` and `hosted_tools` read `0` until it is `ready`; a client should
  render it as pending rather than as a network with no agents.
- `failed` and `stopped` are excluded. A failed build has no site for a pin to lead
  to, and a stop is a deliberate withdrawal. The record keeps its `published_at`, so
  restarting puts the pin back without publishing again.

```json
{ "nodes": [ { "id": "…", "name": "link_demo_travel_agency",
               "org_id": "…", "org_name": "Acme Logistics",
               "status": "ready", "url": "http://127.0.0.1:8101",
               "x": 94, "y": 88,
               "front_man": "travel_concierge", "agent_count": 1,
               "hosted_tools": 0, "open_slots": 0,
               "external_links": 0, "warnings": 2 } ],
  "edges": [ { "source": "<caller id>", "target": "<callee id>",
               "reference": "link_demo_airline",
               "callers": ["travel_concierge"] } ],
  "organizations": [ OrgView, … ],
  "refresh_seconds": 120,
  "totals": { "nodes": 6, "edges": 1, "ready": 1, "organizations": 2 },
  "generated_at": "2026-09-23T02:43:16+00:00" }
```

**Edges are real, not inferred.** An edge exists only where a link actually resolved
at build time — read from the bundle's `linking.imports` with `status == "linked"`.
Nothing here guesses a relationship, and adding a deployment to this map does not
wire it to anything.

- A link whose target is **not** served by this service (a peer running elsewhere)
  cannot be a node, so it is counted in the source node's `external_links` rather
  than silently dropped.
- A *dangling* reference — an agent that calls a network nobody has linked — is
  `open_slots`, not an edge.

**`x`/`y` are percentages of the map viewport and are stable.** A position is assigned
once, at deploy time, and persisted. Adding, restarting, or rebuilding a deployment
never moves an existing pin. Clients should treat the coordinates as opaque.

At startup the service repairs two cases only: a record with no position (written
before the column existed), and a record whose slot is no longer a valid grid slot —
which happens when the artwork's coastline moves, since the candidate grid starts
inland at 22% so a pin cannot sit in the water. Pins already on the grid are left
untouched.

`refresh_seconds` is the server's recommended poll interval (`MAP_REFRESH_SECONDS`,
default 120). It is advice, not a rule — a client may poll at its own cadence.

---

## 4. Deployment endpoints

### 4.1 `POST /deployments` — deploy (multipart)

`Content-Type: multipart/form-data`

<!-- pyml disable md013 -->
| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `file` | file | **yes** | — | the agent-network `.hocon`; UTF-8, non-empty, ≤ `MAX_HOCON_BYTES` (512 KiB) |
| `org_id` | string | no | `Unattributed` | owning organization by id; `400` if unknown. Wins over `org_name` |
| `org_name` | string | no | — | owning organization by name, **created on first use** (§3); ignored when `org_id` is given |
| `name` | string | no | `file`'s basename | becomes the HOCON filename stem, so nsdeploy derives the network name from it |
| `upstream` | string | no | always the service's `UPSTREAM` | **not settable per deployment.** Every site's `/byok/v1` forwards visitors' keys to the service's `UPSTREAM`. Leave it out: a different value is refused with `400` |
| `theme` | bool | no | service `THEME` (off) | deploy-time LLM theming; needs `OPENAI_API_KEY` in the *service* env, listed in `SITE_ENV_ALLOW`, and adds minutes |
| `theme_model` | string | no | service `THEME_MODEL` | only meaningful with `theme=true` |
| `theme_prompt` | string, ≤ 4000 chars | no | service `THEME_PROMPT` (empty) | extra design instructions folded into the theming prompt (nsdeploy's own `--theme-prompt`); only meaningful with `theme=true` |
| `cruse` | bool | no | `true` | inject the CRUSE generative-UI directive; `false` passes `--no-cruse` |
| `ttl_seconds` | int ≥ 0 | no | service `TTL_SECONDS` (`0`) | `0` means never expire — the default, since deployments are long-lived |
<!-- pyml enable md013 -->

**`202 Accepted`** + `Location: /deployments/{id}` + a `DeploymentView` in status `queued`.
The response is returned **before** the build starts — poll or call `/wait`. With
`AUTOPUBLISH` on (the default) that view already reports `published: true`, so a client
can send the user to the map straight away and watch the pin settle there.

```bash
curl -X POST http://127.0.0.1:9100/deployments \
  -F "file=@examples/travel_agent_system.hocon" \
  -F "org_name=Acme Logistics" \
  -F "ttl_seconds=0"
```

### 4.2 `POST /deployments/raw` — deploy (raw body)

The HOCON is the **raw request body**; options move to the query string.

| Param | Type | Required |
| --- | --- | --- |
| `name` | string | **yes** (no filename to fall back on) |
| `org_id`, `org_name`, `upstream`, `theme`, `theme_model`, `cruse`, `ttl_seconds` | as above | no |

```bash
curl -X POST "http://127.0.0.1:9100/deployments/raw?name=my_net" \
  --data-binary @my_net.hocon
```

Identical `202` response. Use this from scripts; use §4.1 from browsers and forms.

### 4.3 `GET /deployments` — list

| Param | Default | Notes |
| --- | --- | --- |
| `org_id` | *(all)* | filter to one organization; `404` if unknown |

`200` → `{ "deployments": [DeploymentView, …], "capacity": {…} }`

Ordered **newest first**, including terminal ones. No pagination (bounded by
`MAX_DEPLOYMENTS` plus retained terminal records).

```json
"capacity": { "live": 0, "max_deployments": 20,
              "ports_reserved": [], "port_range": "8100-8199" }
```

`live` counts `queued` + `building` + `ready` — the figure checked against `MAX_DEPLOYMENTS`.

### 4.4 `GET /deployments/{id}` — poll

`200` → `DeploymentView`. `404` if unknown.

### 4.5 `GET /deployments/{id}/wait` — block until settled

| Param | Type | Default | Range |
| --- | --- | --- | --- |
| `timeout` | int (seconds) | `600` | 1–1800 |

- `200` → `DeploymentView` once the status is `ready`, `failed`, or `stopped`.
- **`504`** → `DeploymentView` with the *current* state if the timeout elapses first.
  This is **not an error**: the build is usually still running. Treat `504` as "keep
  waiting", not "it broke", and re-issue the call.

Polls internally every 0.4s. Note `timeout` is independent of `BUILD_TIMEOUT_SECONDS`
(600s), which is what actually fails a stuck build.

### 4.6 `GET /deployments/{id}/logs` — build output

nsdeploy's own stdout/stderr — the dependency report, tool-hosting lines, and any traceback.

| Param | Type | Default | Semantics |
| --- | --- | --- | --- |
| `tail` | int, 0–5000 | `LOG_TAIL_DEFAULT` (200) | last N lines; **`0` = the whole log**; omitted = service default |

`200` → `{ "id", "status", "lines": [string], "truncated": bool }`

`lines` are newline-stripped. `truncated` is `true` when earlier lines were dropped.
Available in every state, including while `building` (this is how you watch progress).

### 4.7 `POST /deployments/{id}/restart` — relaunch

Rebuilds a `stopped` or `failed` deployment from the HOCON still stored in its work
directory. **`202 Accepted`** + a `DeploymentView` back in status `queued`; poll or
`/wait` as with a fresh deploy.

Three guarantees worth relying on:

- **The record id is unchanged**, so links into the directory stay valid.
- **The original port is requested back**, so the site's URL normally survives the
  relaunch. The origin is baked into the generated bundle, so a different port means a
  different URL — if something else has taken the port meanwhile, any free port is used
  and `url` changes. Always re-read `url` from the response.
- **The caller's original options are replayed** (`theme`, `cruse`, `ttl_seconds`,
  `org_id`), not re-derived from whatever the service defaults are now. The BYOK
  upstream is the exception: a site always forwards to the service's current `UPSTREAM`.

The previous attempt's log is kept and the new run is appended after a
`=== nsdeploy-service: new run ===` separator. Everything that parses the log is scoped
to the latest run, so a restart does not double-count tools or resurrect a stale error.

`400` when: the deployment is unknown, it is already `queued`/`building`/`ready`, the
service is at capacity, or **the stored HOCON is no longer on disk** (`the uploaded
HOCON for <name> is no longer on disk (<path>); upload it again to deploy`) — which is
what happens if the work directory was cleaned.

### 4.7a `POST /deployments/{id}/theme` — edit theme and relaunch

`Content-Type: application/json`. Edits this deployment's own theme override and
relaunches it with the new values — the one way to change what a *live* network
already has, rather than only what the next fresh upload would get.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `theme` | bool | no | omit to leave this deployment's existing override alone |
| `theme_refresh` | bool | no | omit to leave this deployment's existing override alone |
| `theme_prompt` | string, ≤ 4000 chars | no | omit to leave this deployment's existing override alone |

Every field is optional and independent — sending only `theme_prompt` changes the
prompt without touching `theme`/`theme_refresh`. There is no way to *clear* an
override back to the service default through this endpoint; redeploy to do that.

Unlike §4.7, this works whether the deployment is live or terminal: a live one is
stopped first, then relaunched exactly as `restart` does — same record id, same
port request, same stored HOCON — except with the edited fields folded into the
replayed options. Because a relaunch persists whatever options it runs with, the
edit also sticks for every subsequent plain `restart`.

**`202 Accepted`** + a `DeploymentView` back in status `queued`; poll or `/wait` as
with a fresh deploy. Same `400` cases as §4.7 (deployment unknown, capacity, missing
stored HOCON).

```bash
curl -X POST http://127.0.0.1:9100/deployments/abc123/theme \
  -H "Content-Type: application/json" \
  -d '{"theme": true, "theme_refresh": true, "theme_prompt": "Use a dark navy editorial design"}'
```

### 4.7b `GET`/`POST /deployments/{id}/theme-spec` — restyle without rebuilding

§4.7a is the *design* path: it re-asks the model for a layout and costs a stop, a
rebuild and a relaunch. This is the *token* path. Colours, corner radius, typeface and
the brand copy are named fields on nsdeploy's `ThemeSpec` that compile to CSS custom
properties, so changing one needs no model, no key and **no relaunch** — the service
rewrites the built stylesheet and manifest in place, and a deployed site reads both
off disk per request, so the next page load serves the new look.

`GET` answers the current look and what can be done with it:

<!-- pyml disable md013 -->
| Field | Type | Notes |
| --- | --- | --- |
| `current` | ThemeTokens | the values in effect |
| `defaults` | ThemeTokens | the stock look, to offer as a reset without hardcoding it client-side |
| `source` | string | `site-source` (editable source — what the next build will use), `built` (read from the bundle), or `default` |
| `has_custom_layout` | bool | a model-authored layout is in place. Editing tokens keeps it; a generic preview will not show it |
| `built` | bool | a built bundle exists, so an edit can take effect without rebuilding |
| `live` | bool | the site is running, so an edit shows on its next page load |
<!-- pyml enable md013 -->

`POST` takes a `ThemeTokens` body. Every field is optional; `None` means "leave this
one alone".

<!-- pyml disable md013 -->
| Field | Type | Notes |
| --- | --- | --- |
| `brand` / `icon` / `tagline` / `hero` | string | ≤ 60 / 8 / 120 / 280 chars. Empty means "unset", and the build's own derivation (brand from the network name, description from the agent's) is left in place rather than blanked |
| `font` | string | CSS font stack, ≤ 120 chars. Normalized — a stack without a generic family gains `, system-ui, sans-serif` |
| `radius` | int | 0–28 px; outside that range is `422` |
| `colors` | object | any subset of `primary`, `accent`, `bg`, `bg_tint`, `fg`, `muted`, `border`, `msgbg`, `panelbg`. `#hex`, `rgb()`/`hsl()`, or a CSS keyword |
<!-- pyml enable md013 -->

**`200 OK`** → `{current, applied_live}`. Not `202` and not a `DeploymentView`: no
relaunch is queued and the record does not change, so there is nothing to poll.
`applied_live` is false only when the network has never been built — the edit is saved
to its editable source and lands on the first build.

An **unparseable colour is `422`, not a silent revert**. `ThemeSpec.coerce` fails open
to the *default* colour, which is right for a build (there is no previous value) and
wrong for an edit, where a typo would come back as stock blue and read as "applied,
just not the way I meant". An **unknown colour key is ignored**, so a console that
sends a token this build does not know does not fail the whole edit.

The layout (`body`/`style`) is never touched here: those live in the editable
source's `layout.html` / `theme.css` and are carried through an edit untouched.

```bash
curl http://127.0.0.1:9100/deployments/abc123/theme-spec

curl -X POST http://127.0.0.1:9100/deployments/abc123/theme-spec \
  -H "Content-Type: application/json" \
  -d '{"brand": "Harbor Wheels", "radius": 8, "colors": {"primary": "#0f766e"}}'
```

### 4.8 `DELETE /deployments/{id}` — tear down

| Param | Default | Notes |
| --- | --- | --- |
| `purge` | `false` | also delete the record, removing it from the directory |

`200` → the `DeploymentView` in status `stopped`. `404` if unknown.

Kills the **whole process tree** (the site, one FastMCP host per hostable tool, and the
public MCP facade) and releases the port. **Idempotent**: deleting an already-terminal
deployment is a no-op that returns its current state, still `200`.

### 4.9 `GET /health` — ops (unauthenticated)

```json
{ "status": "ok", "version": "0.1.0", "python": "3.14.0",
  "platform": "Windows-11-10.0.26100-SP0",
  "deployments": { "queued": 0, "building": 0, "ready": 1, "failed": 0, "stopped": 2 },
  "port_pool": { "range": "8100-8199", "capacity": 100, "reserved": [8100] },
  "reconciled_at_startup": 2,
  "warnings": [] }
```

Suitable as a liveness/readiness probe. `status` is always `"ok"` when the process is
serving.

**`warnings` are ongoing conditions**, expected to persist until an operator fixes the
underlying cause, such as "bound off-loopback with no `API_TOKEN`", `THEME` on while
site builds do not receive `OPENAI_API_KEY` (see `SITE_ENV_ALLOW` in the service README),
or "`CONSOLE_PROXY` is on". Because a warning repeats on every poll, **a client must surface
a given message once**, not per response; the console keys off the message text to do that.

**`reconciled_at_startup` is a one-off statistic**, not a warning: how many records this
run settled to `stopped` at boot because their processes did not survive a restart
(§2). It is deliberately *not* in `warnings` — a one-time event reported as an ongoing
condition gets re-raised by every poll forever. The actionable surface for those records
is the directory, where each carries the reason and a **Restart** button (§4.7).

---

## 4a. Static bundle endpoints

A **static bundle** is a self-contained folder of files — `index.html`, the shared
runtime, the network JSON and the manifests — that runs the network in the browser with
no server behind it. It is a build product, not a deployment: no port, no process, no
place on the map, no record. Nothing a bundle request produces is kept, and nothing
about it appears in `GET /deployments`, `/directory` or `/graph`.

So these endpoints are **synchronous**. There is no `202`, no id to poll and no
lifecycle: one request in, the archive out. A build is typically a few seconds, because
a static bundle loads no Python toolbox; the slow part is resolving `include` lines,
which may reach GitHub on a cold cache.

### 4a.1 `POST /bundles` — build and return (multipart)

`multipart/form-data`, same shape as §4.1.

| Field | Required | Notes |
| --- | --- | --- |
| `file` | yes | the agent-network `.hocon` |
| `name` | no | network name; defaults to the uploaded filename stem. Names the archive. |
| `site_url` | no | the origin the client will host the bundle on |
| `upstream` | no | LLM endpoint the page calls with the reader's own key |
| `theme` | no | run LLM theming; **off by default** (see below) |
| `theme_model` | no | model used when `theme` is on |
| `theme_refresh` | no | re-ask the model rather than reuse a cached answer |
| `theme_prompt` | no | extra design instructions, 4000 characters maximum |
| `cruse` | no | inject the CRUSE generative-UI directive; defaults to the service setting |

`200` → `application/gzip`, body is the bundle. `400` with a `detail` for anything the
caller can correct: an empty, oversized, non-UTF-8 or unparseable HOCON, a name that is
not a plain identifier, or a network with no front-man agent.

**The archive has the files at its root**, so unpacking it into a directory puts
`index.html` at that directory's root. That is exactly what `bundle_host` validates, and
it means no reader needs `--strip-components`.

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
     -F file=@corner_shop.hocon \
     -F site_url=https://shop.example.com \
     -D headers.txt \
     http://127.0.0.1:8000/bundles -o corner_shop.tar.gz
mkdir -p site && tar -xzf corner_shop.tar.gz -C site   # site/index.html
```

### 4a.2 `POST /bundles/raw` — build and return (raw body)

The HOCON is the whole request body; every field above is a query parameter, and `name`
is required because there is no filename to fall back on. Identical output: the same
HOCON and the same options give byte-identical archives on both routes.

### 4a.3 Response headers

The body is the bundle, so everything else the build reported travels beside it.

| Header | Notes |
| --- | --- |
| `Content-Disposition` | `attachment; filename="<name>.tar.gz"` |
| `X-Bundle-Name` | the validated network name |
| `X-Bundle-Files` | how many files are in the archive |
| `X-Bundle-Unpacked-Bytes` | their total size unpacked |
| `X-Bundle-Sha256` | digest of the archive |
| `X-Bundle-Warnings` | JSON array; absent when there are none |

Fetching from another origin, a browser hides all of these unless the server names them
— it does, but only when `CORS_ORIGINS` is set (§1).

`X-Bundle-Sha256` is an **identity, not a receipt**. The packer flattens ownership, mode
and timestamps, so one network always packs to one set of bytes: a client can compare
the digest against what it already holds to tell a changed bundle from a re-sent one.
The warning list is trimmed if it would exceed a proxy's header limit, and the last
entry then says how many are missing.

### 4a.4 `site_url` is baked in

A static bundle is built **for a particular origin**. `site_url` is written into
`agent-manifest.json`, `.well-known/nsdeploy-agent.json` and the generated steward
HOCON, and it cannot be changed afterwards without rebuilding. Omitting it builds a
bundle addressed relative to wherever it is served, which works only at a domain root.

A client that relays the bundle to a separate web server must therefore send **that
server's** public URL, not its own.

### 4a.5 Theming is opt-in here

Unlike a deployment, a bundle is **not** themed just because the service-wide `THEME`
setting is on. Theming calls a model and adds 30-90 seconds; a deployment hides that
behind its `202`, but this endpoint answers on the open connection, so a service-wide
default would make every bundle request a long one. Send `theme=true` to ask for it.

With `theme=true` but no `OPENAI_API_KEY` in the service environment, the build still
succeeds with the default look and says so in `X-Bundle-Warnings`. The same is true if
the model is unreachable or returns a layout the sanitizer refuses.

### 4a.6 What a static bundle cannot carry

Reported per build in `X-Bundle-Warnings`:

- **Python coded tools are omitted.** They need a host process, which a bundle has none
  of. The agents that referenced them are generated without them.
- **The public MCP facade is unavailable.** Private stewards fall back to fetch-and-run.
- **External MCP servers are called straight from the browser** and must allow CORS.

### 4a.7 `GET /deployments/{id}/bundle` — a bundle for a deployed network

Takes a `deployment_id` from `POST /deployments` and answers with the same archive and
the same headers as `POST /bundles`, plus `Cache-Control: no-store`.

```text
GET /deployments/7f3c1a2b9d04/bundle?site_url=https://shop.example.com
Authorization: Bearer <token>
```

<!-- pyml disable md013 -->
| Query | Default | Notes |
| --- | --- | --- |
| `site_url` | *(empty)* | where the client will host the bundle; see §4a.4. **Never defaults to the deployment's own URL**, which is this service's loopback port and would be useless anywhere a bundle is hosted |
| `upstream` | the service's `UPSTREAM` | BYOK upstream for this bundle only; one stored in the record is never used |
<!-- pyml enable md013 -->

There is nothing else to pass. The network name, the CRUSE setting and the look come
from the deployment, and the BYOK upstream is the service's `UPSTREAM`, which every
deployed site is launched with (§4.1). So the bundle matches the site that is already
running.

**`ready` and `stopped` deployments can both be bundled.** A network does not stop
being worth packaging when its process is torn down: the HOCON and the editable
source outlive the site, so taking a deployment down and then wanting it as a static
site is an ordinary order of events. Status gates the request but is not an input to
the build, so one deployment gives the same archive before and after it is stopped.

Note that `stopped` does not prove a deployment ever served. A build that was still
running when this service was restarted is reconciled to `stopped` at start-up, and
so is one deleted while it was building. Such a record bundles like any other — the
HOCON is there — but it has never been proved to work, and `ready_at` on
`GET /deployments/{id}` is `null` when that is the case.

**This is a rebuild, not an export.** A deployed site is generated for a server:
absolute asset paths, a live MCP facade, tool URLs on its own origin, and a
`links_endpoint`. A static bundle has none of those, so the served tree cannot be
repacked. The HOCON the deployment was created from is resolved and generated again
with the static-bundle switch on. Two consequences: `include` lines are re-fetched, so
a bundle can differ from the running site if upstream has moved since the deploy; and
a deployment that is `ready` can still answer `400` here if its HOCON no longer
resolves.

**The look is inherited, never re-asked.** The theme comes from the deployment's
editable source (`site-source/theme.json`), which is what its next build would use and
what `POST /deployments/{id}/theme-spec` writes to. The built site is the fallback, the
default look is the floor, and each fallback is reported in `X-Bundle-Warnings`. No
model is called, so this endpoint stays as fast as `POST /bundles`.

Statuses:

<!-- pyml disable md013 -->
| Code | When |
| --- | --- |
| `200` | the archive |
| `404` | no deployment with that id |
| `409` | the deployment is `queued`, `building` or `failed`. The first two have produced no site yet and the third tried and could not, so none of them has anything finished to offer |
| `410` | the record is there but its HOCON is not on disk — a `WORK_ROOT` that moved between runs, or a work dir removed by hand. Gone rather than Not Found, because the deployment is real and it is its source which is missing |
| `400` | the HOCON no longer resolves, or the network has no front man |
<!-- pyml enable md013 -->

The deployment is **read only**. Nothing is written to its work directory, its record
is untouched, and its status does not change.

### 4a.8 Limits

`MAX_HOCON_BYTES` applies, and is checked before a build slot is taken.
`MAX_CONCURRENT_BUNDLE_BUILDS` (default 4) bounds how many run at once — a separate
bound from `MAX_CONCURRENT_BUILDS`, so a bundle never queues behind a cold deployment.

---

## 5. Schemas

### 5.1 `DeploymentView`

<!-- pyml disable md013 -->
| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | 12 hex chars; the only identifier clients should persist |
| `name` | string | validated network name (see §6) |
| `org_id` / `org_name` | string | owning organization |
| `status` | enum | `queued` \| `building` \| `ready` \| `failed` \| `stopped` |
| `url` | string \| null | **the deployed site URL** — non-null only when `ready` |
| `port` | int \| null | null once terminal (the port has been released) |
| `created_at` | string | accepted-at |
| `ready_at` | string \| null | first successful HTTP probe |
| `stopped_at` | string \| null | set for `failed` and `stopped` |
| `expires_at` | string \| null | null when TTL is disabled |
| `error` | string \| null | one-line reason; non-null for `failed` |
| `pid` | int \| null | the child's PID; retained after exit for diagnostics |
| `theme` / `theme_refresh` / `theme_prompt` | bool / bool / string, all \| null | this deployment's own theme override, as stored — `null` means "falls back to the service default" (see §4.1, §4.7a) |
| `endpoints` | object | `{}` unless `ready` (see §4.2) |
| `network` | object \| null | null until `ready` (see §4.3) |
| `warnings` | string[] | non-fatal findings (see §4.4) |
<!-- pyml enable md013 -->

### 5.2 `endpoints` (populated when `ready`)

| Key | Route | What it is |
| --- | --- | --- |
| `site` | `/` | the agent-network website |
| `mock_llm` | `/v1/chat/completions` | keyless deterministic mock; makes no outbound calls |
| `byok_proxy` | `/byok/v1/chat/completions` | forwards the *visitor's* `Authorization` to the service's `UPSTREAM` |
| `mcp_facade` | `/mcp` | machine-facing MCP server (`invoke_network`), for private stewards |
| `agent_manifest` | `/agent-manifest.json` | brand, routers, linking metadata |
| `well_known` | `/.well-known/nsdeploy-agent.json` | MCP discovery document |

The service never holds an LLM key; real completions always carry the caller's own.

### 5.3 `network` (build result)

| Field | Type | Source |
| --- | --- | --- |
| `front_man` | string | generated bundle |
| `agent_count` | int | generated bundle |
| `brand`, `description`, `sample_queries` | string / string / string[] | generated bundle |
| `link_slots` | string[] | generated bundle — unlinked agent-network references |
| `links` | `{reference, target, callers}[]` | generated bundle — **resolved** outbound links; the map's edges |
| `hostable_tools` | string[] | nsdeploy's report — tools now running as MCP servers |
| `missing_tools` | string[] | nsdeploy's report — **dropped** from the deployed network |
| `demo_mode_agents` | string[] | nsdeploy's report — agents that fabricate answers |
| `external_mcps` | string[] | nsdeploy's report — proxied remote MCP URLs |

> Structural fields come from the generated bundle and are authoritative. The four
> **name lists are parsed from nsdeploy's stdout report**, because those names are not
> recorded anywhere machine-readable. A parse miss yields an empty list, not an error —
> so treat an empty list as "not reported", not as a guarantee of absence, and read
> `/logs` when it matters.

### 5.4 `warnings`

Present on a **successful** deployment to flag silent degradation. Never a failure.

1. "N tool reference(s) could not be resolved and were dropped…"
2. "N agent(s) run in demo_mode and fabricate plausible answers…"
3. "N unlinked agent-network reference(s)…"

---

## 6. Validation & errors

<!-- pyml disable md013 -->
| Code | Body | When |
| --- | --- | --- |
| `202` | `DeploymentView` | deployment accepted |
| `200` | varies | read/delete succeeded |
| `400` | `{"detail": "<message>"}` | rejected by the service (below) |
| `401` | `{"detail": "a valid bearer token is required"}` | auth configured and not satisfied |
| `403` | `{"detail": "<message>"}` | `/console-api` request refused while `CONSOLE_PROXY` is on (§1) |
| `404` | `{"detail": "no deployment '<id>'"}` | unknown id |
| `409` | `{"detail": "<message>"}` | conflicts with existing state: duplicate org name, or deleting an org that still owns records |
| `422` | `{"detail": [{"type","loc","msg","input"}, …]}` | FastAPI schema validation (missing `file`, `tail` out of range, …) |
| `504` | `DeploymentView` | `/wait` timed out — still in progress, not an error |
<!-- pyml enable md013 -->

`400` cases, each with an explanatory `detail`:

- `the uploaded HOCON is empty`
- `HOCON is N bytes; the limit is 524288`
- `HOCON must be UTF-8 text: …`
- `This service is already running its maximum of M networks…` — the live ceiling
  (`MAX_DEPLOYMENTS`) is reached. Worded for the person at the upload form, who is
  usually not the one who can raise the limit or stop somebody else's network.
- `no free port in 8100-8199; stop an existing deployment first`
- `no organization '<id>'` (unknown `org_id` on a deploy)
- `Per-deployment upstream is not supported…` — the upload named an `upstream` other
  than the service's own (§4.1)
- `invalid network name '<raw>': use 1-64 characters of letters, digits, '_' or '-'
  (optionally with a .hocon/.conf suffix), and no path separators`

**Name rule.** `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` after stripping one trailing
`.hocon`/`.conf`. Invalid names are **rejected, not sanitised** — `name=../../evil` is a
`400`, not a silent rename. An *upload filename* may legitimately arrive as a path from
older clients, so only there is the basename taken before validation.

Note `400` is used for semantic rejection and `422` for schema violations — a client
should treat both as "fix the request".

---

## 7. Client recipe

```bash
BASE=http://127.0.0.1:9100

id=$(curl -sf -X POST $BASE/deployments \
      -F "file=@my_net.hocon" -F "ttl_seconds=0" | jq -r .id)

# /wait returns 504 while still building — loop until it settles.
while :; do
  body=$(curl -s -w '\n%{http_code}' "$BASE/deployments/$id/wait?timeout=120")
  code=$(tail -n1 <<<"$body"); view=$(sed '$d' <<<"$body")
  [ "$code" = "504" ] || break
done

case $(jq -r .status <<<"$view") in
  ready)  jq -r '.url, (.warnings[]? | "warning: " + .)' <<<"$view" ;;
  *)      jq -r .error <<<"$view"; curl -s "$BASE/deployments/$id/logs?tail=0" \
            | jq -r '.lines[]'; exit 1 ;;
esac

# when finished
curl -sf -X DELETE "$BASE/deployments/$id" > /dev/null
```

Expect **~20s** to `ready` on a warm cache; a cold build fetches includes from GitHub and
may `pip install` a tool's dependencies, so allow minutes for the first deploy of a network.

---

## 8. Stability notes for the hosted phase

These are contract-visible consequences of moving off localhost — see
[README_SERVICE.md](README_SERVICE.md#before-hosting-this).

- **`url` shape changes with routing.** Port-per-deployment (`http://host:8100`) locally;
  set `SUBDOMAIN_TEMPLATE` for `https://<id>.host` with no port. Clients must treat `url`
  as opaque and never reconstruct it from `port`.
- **Path-prefix URLs will never be offered.** The generated bundle's routes are
  root-absolute, so `https://host/d/<id>/` cannot work.
- **`pid` and `port`** are implementation detail, exposed for local debugging. Do not
  depend on them; they become meaningless under container-per-deployment.
- **Records persist, processes do not.** Deployment records survive a restart; the sites
  themselves are reconciled to `stopped`. Nothing re-launches them automatically — if
  "an org's URL stays up across a service restart" becomes a requirement, that needs a
  supervisor that re-deploys reconciled records on boot.

---

## 9. The deployment console

A modular, build-step-free frontend in the top-level [`ui/`](ui/) folder, served
same-origin at `/app/`.

```text
ui/
  index.html
  assets/styles/   tokens · base · layout · components
  assets/js/
    main.js               bootstrap, theme, tab routing
    api/client.js         the only place that talks HTTP
    api/auth.js           auth strategy — the seam for login
    views/                deploy (launch) · map · directory · organizations ·
                          networks (the flat list)
    components/           deployProgressModal (the launch dialog) · modal ·
                          publishModal · toast · widgets · graph ·
                          designStudio + sitePreview (the design editor)
    util/                 dom (escaping, icons) · format (status, dates) ·
                          color (resolution + WCAG contrast)
```

**The console offers two choices: New network and Map.** The tabs are named as
*places*; "Launch" is reserved for the button inside the first one, so no word means
both a destination and an action. Its users are not deploying
software for a living, so the main path is one screen with two fields — organization
name and a drop-zone — and one Launch button, then the map. Concretely:

- The launch form sends only `file` and `org_name`. Everything else `POST /deployments`
  accepts comes from the service defaults, so there is nothing on screen to read past
  or get wrong. The API is unchanged; scripted callers still pass whatever they like.
- The organization is free text backed by `org_name`'s get-or-create (§3), so a
  first-time operator never has to create a profile before their first upload. The
  last value is remembered in `localStorage`.
- Over-sized and wrong-suffix files are rejected in the browser at pick time, with the
  reason in words under the file name — not after pressing Launch.
- **Launch opens a dialog that closes itself.** Between pressing Launch and the site
  answering there is nothing to do and nothing to decide, so
  [`deployProgressModal.js`](ui/assets/js/components/deployProgressModal.js) owns that
  wait — and because there is nothing to decide, there is almost nothing to read: the
  loader, three one-word pips, one short line of what is happening, and a clock. About
  eight words on screen. On success it holds a tick for ~1.1s, closes itself, and shows
  the map. No buttons; the only panel with a control is failure, which is the only
  outcome that needs a decision. It polls `/wait` (504 = still building) and `/logs`,
  and it is the only place a failed build is reported — a failed deployment is not
  drawn on the map, so no pin could carry the error. Three rules keep it honest:
  - the pips track the three states the API reports (`queued`, `building`, `ready`) —
    no invented sub-steps or fabricated percentages;
  - the "currently doing" line is the real last line of nsdeploy's build log, restated
    in plain language, with absolute paths and the report's indented detail filtered
    out. Unrecognised lines pass through rather than being replaced by a guess;
  - past 30s it notes that a first run takes longer, instead of letting the wait feel
    broken.
  - build caveats are announced as a toast rather than printed, because a dialog that
    closes itself would never have them read.
- **The map is `/app/?focus=<id>#map`, and the operator always lands on it.** A new tab
  is attempted first, but `window.open` only succeeds while the page holds transient
  activation and a ~20s build outlives that — verified: without a gesture Chrome
  returns `null`. So a blocked open falls back to navigating the current tab, which can
  never be blocked. There is deliberately no "Open the map" button to click: a button
  that has to be found is the dead end this replaced.
- **The focused pin is introduced, not left to be found**: announced by toast, traced
  with its callout, and haloed for 9s. The halo is re-applied after *every* repaint,
  because `paint()` replaces the pins' markup — a one-shot guard meant a background
  poll silently threw it away and it never came back.
- **Directory and Organizations are off the main path, not removed.** They own stop,
  restart and remove, and stay reachable from the footer's "Manage deployments" link
  or a `#directory` / `#organizations` hash.
- **The network list shows every organization and gates the actions, not the rows.**
  Anyone can see what is deployed and open "What it does"; resume, stop, restyle and
  remove are offered only on rows whose `org_name` matches the organization
  remembered in this browser, and with none set nothing is manageable. The disabled
  controls stay hoverable so their `title` can say whose network it is — a greyed
  button with no reason reads as a broken console.
  **This is a guardrail, not enforcement.** §1's token identifies "someone allowed
  to use this service", never a particular organization, so the API accepts a stop
  or a delete for any network from any holder of it. The UI prevents an accident,
  not an attacker; real isolation needs the login mechanism §1 describes, and when
  it lands the server becomes where this rule lives. Note the Directory
  (`#directory`) still offers those actions ungated.
- **"What it does" is a reader's page, not an operator's readout.** It is the one
  action offered on every row, including other organizations', so
  [`agentDescriptionModal.js`](ui/assets/js/components/agentDescriptionModal.js)
  answers in the order a stranger asks: the description in prose, then the
  network's own sample queries (a concrete question explains a network faster than
  a noun phrase about it), then what is weak, then the wiring, then a link to the
  live site. Demo-mode agents and unresolved tools are stated as consequences —
  *"they produce realistic-looking answers without real data or tools behind
  them"* — and sit above the wiring, because a reader deciding whether to trust an
  answer needs them and the dialog scrolls.
- **The design editor separates the two prices of "change how this looks."** The
  palette icon on a network's row opens
  [`designStudio.js`](ui/assets/js/components/designStudio.js): controls on the left,
  a live preview on the right, applied by §4.7b with no rebuild. Structure stays a
  prompt, in its own group, because it genuinely costs a rebuild (§4.7a) — the point
  is to stop charging that price for a colour. Three things it does deliberately:
  - **The preview is real, not a swatch grid.** It renders the deployed chat UI in a
    sandboxed `srcdoc` iframe using the same `--ns-*` properties and `.ns-*` class
    names nsdeploy emits, so changing a token recolours it exactly as it recolours a
    site. No `allow-scripts`, so nothing in it can execute; same origin, so a draft is
    applied by rewriting one `<style>` element rather than reloading per keystroke.
    Where a network has a model-authored layout the preview says *standard surfaces*
    instead of implying it is the whole truth.
  - **Contrast is checked while colours are chosen**, on the pairs the deployed UI
    actually puts together — and the user bubble is measured against the *lighter* end
    of its gradient, since white text fails on the lighter one first.
  - **It warns only about what the operator touched.** The shipped palette is already
    below AA in two of those pairs (muted text 4.35:1, white on the default primary
    2.77:1), so warning on everything would open the editor to three complaints about
    choices nobody made — and a warning that is always on is one nobody reads. The
    ratios are always shown, so a pre-existing problem stays visible; the alarm is
    reserved for a pair whose own colours this session changed.

- **A rejected submit marks the field, not just a toast.** A corner toast lands away
  from the button the operator just pressed and does not say *which* field is wrong;
  on a two-field form that reads as "I clicked Launch and nothing happened". Both
  fields are checked together, each fault is shown beside its field with
  `aria-invalid` and persists until the operator acts on it, and the first offending
  field is focused and scrolled to. Launch is never disabled — a dead button is the
  same dead end.

Motion in the console is decorative and always optional: the launch loader, the
travelling dashes on map edges, the staggered pin entrance and the just-deployed halo
are all inside `@media (prefers-reduced-motion: no-preference)`, and every state they
express is also carried by text, a glyph, or a border.

### Staleness

`GET /health` reports `ui_version`: the `?v=N` the served `index.html` pins its assets
to. The console records the version it booted with (from its own `import.meta.url`)
and shows a **"Reload to update"** bar when the server reports a different one.

This is not cosmetic. `Cache-Control: no-cache` on the entry document only helps a
*fresh* navigation — a tab that was already open when the service was updated never
re-navigates, so it keeps running the JavaScript it booted with. A console running the
previous release's code against this release's server is indistinguishable from a
broken UI, and was in fact reported as "I clicked Deploy and nothing happened" on a
build where that button had been renamed to Launch. An empty `ui_version` means
"cannot tell" and is deliberately **not** treated as a mismatch, so an unreadable
version never nags.

Bump `?v=N` in [`ui/index.html`](ui/index.html) whenever a console asset changes; it is
the one manual step, and it is what both cache-busting and this check key off.

The **Map** tab is full-bleed, drawn over a cartographic backdrop
([`mapArt.js`](ui/assets/js/components/mapArt.js) — coastline, parkland, city blocks,
cased roads, piers), and follows the Cailville interaction model:

- **hover or focus a pin** → trace its links: unrelated pins and edges recede, the
  connected ones highlight, and a readout appears over the map narrating
  *"calls X · called by Y"*. It is shown only while tracing.
- **click a pin** → opens that network's site in a new tab. A live pin is a real
  `<a target="_blank" rel="noopener">`; a stopped one has no URL, so it renders
  `aria-disabled` and stays hoverable but unclickable.

Edges are measured in **pixel space** from each pin's bounding box and inset to its
boundary, so an arrowhead lands beside the target pin rather than underneath it; the
edge SVG's viewBox tracks the frame's pixel size so arrowheads are never skewed.
Both mean edges are redrawn on resize, not only on data change.

**The map has one control.** It opens showing every organization and every
deployment; a pill in the corner scopes it down to the organization remembered in
this browser, and appears only once there is one. That default is deliberately the
opposite of the network list's: the list is an operator's own inventory, while the
map is the shared picture of what connects to what, and an all-pairs graph with one
organization's pins removed is not a smaller map but a misleading one — the edges to
those pins disappear with them. Otherwise there is nothing to set: the refresh
cadence is whatever `/graph` advertises in
`refresh_seconds` (`MAP_REFRESH_SECONDS`, default 60s) — the view adopts a changed
value on its next poll. Configure it in the service settings, or in the constants at
the top of [`map.js`](ui/assets/js/views/map.js). Polling stops while the tab is
hidden. The legend, the counters and the hover
readout float over the stage, so no chrome competes with the map for height.

Two encoding constraints shape it:

- **Organization is not a colour channel.** A spatial graph is an all-pairs form —
  any node can sit beside any other — and the categorical palette only clears the
  colour-vision separation floors for three slots under those conditions (six slots
  measured ΔE 3.2 protan, with one pair at 12.9 for normal vision). Org identity is
  carried by each pin's text plus a filter, which also scales past three orgs.
- **Status is glyph + label + ring style**, never hue alone.

Three properties make this cheap to relocate or replace:

1. It consumes **only the endpoints documented above** — no server-rendered templates,
   no private routes, no shared session state.
2. Auth lives entirely in `api/auth.js`. Replacing the shared token with a session
   cookie or OIDC means editing that one file; no view imports from it.
3. It is static files served via `NSDEPLOY_SERVICE_UI_DIR`. Moving it to a CDN or a
   separate origin needs a CORS policy server-side and a `BASE` value in
   `api/client.js` — nothing structural.

Accessibility notes that constrain the markup: deployment status is always rendered as
**glyph + word**, never colour alone, because the status palette's `good` and `critical`
measure ΔE 4.1 under deuteranopia; and dark mode uses separately chosen steps rather than
an inverted light palette.
