# nsdeploy

Take a neuro-san(-studio) agent-network **HOCON**, check its dependencies, host its
tools as **MCP servers**, generate a static **index.html**, and **serve the network
as a website** — with **no neuro-san server** and no runtime dependency on neuro-san.

This is a standalone project. **No neuro-san-studio checkout is required** — by
default nsdeploy pulls just the files it needs (`aaosa.hocon`, `toolbox_info.hocon`,
coded-tool `.py` sources, …) from the public
[neuro-san-studio](https://github.com/cognizant-ai-lab/neuro-san-studio) GitHub repo
on demand, caching them under `~/.cache/nsdeploy/`. Files are located by suffix-
matching the repo's git tree, so the repo's internal layout doesn't matter. Any pip
dependency a hosted tool imports (e.g. `ddgs`) is auto-installed on demand.

The browser runs the agents on **neuro-san's own agent loop**, from
[`@cognizant-ai-lab/neuro-san-ts-package`](https://github.com/cognizant-ai-lab/neuro-san-ts-package)
(the real neuro-san Python transpiled to TypeScript), bundled by
[`runtime-build/`](runtime-build) into `nsdeploy/runtime/ts-package/generated/` and driven by the page
runtime in [`nsdeploy/runtime/ts-package/`](nsdeploy/runtime/ts-package), which shares the rest of
[`nsdeploy/runtime/`](nsdeploy/runtime) with the original runtime (`--use-ts-package false`). See
[The agent loop](#the-agent-loop). A normal served deployment uses Python for the
build-time HOCON resolver, the web launcher, and one small MCP server per hostable
tool. A static bundle uses Python only while building; the resulting webroot has no
Python or nsDeploy runtime dependency.

## Install & run

```bash
pip install "mcp>=1.0.0" uvicorn starlette pyhocon neuro-san

# Build the browser runtime before the first run, and after each neuro-san package update.
# It is build output, so it is not checked in (see The agent loop).
(cd runtime-build && npm install && npm run build)

# Tools are pulled from GitHub automatically — no --studio needed:
python -m nsdeploy examples/travel_agent_system.hocon --port 8080
```

To deploy networks that live in **another project**, install nsdeploy into that project's
environment and run it from there. Every path is relative to your working directory or
the HOCON file, and the browser runtime ships inside the package, so editable and regular
installs both work:

```bash
pip install -e /path/to/nsdeploy      # or: pip install /path/to/nsdeploy, or git+<url>
python -m nsdeploy examples/my_network.hocon --port 8091 --theme --theme-model gpt-5.5
```

The generated site goes to `./.nsdeploy/` (add it to that project's `.gitignore`), the
editable site source to `<hocon-dir>/sites/<name>/`, and fetched tool sources and theme
results are cached under `~/.cache/nsdeploy/`.

Then open <http://127.0.0.1:8080/>. Flags: `--repo`/`--ref` (GitHub source, default
`cognizant-ai-lab/neuro-san-studio@main`), `--studio DIR` (use a local checkout
instead of GitHub), `--no-serve` (generate only), `--port`, `--out` (site dir),
`--site-dir` (editable HTML/CSS/JS source),
`--site-url` (public origin), `--link`/`--links` (outbound network bindings),
`--upstream` (BYOK proxy upstream), `--runtime-dir` (override the vendored runtime),
`--no-cruse` (skip generative-UI injection), `--use-ts-package true|false` (run the agents
on the neuro-san TS package, true by default; false, or `USE_TS_PACKAGE=0` for
Cailville, runs the original runtime),
and the theming flags below.

## Shared subdomain gateway

Port-based hosting remains the default for backward compatibility. When the hosting
environment limits exposed ports, the optional gateway can publish any number of
nsdeploy sites through one listener and select the site from the request hostname.
The network name becomes a DNS-safe subdomain (`harbor_town_hall` becomes
`harbor-town-hall`):

```bash
# Start the sites on loopback ports and advertise their public subdomain origins.
python -m nsdeploy examples/link_demo_airline.hocon \
  --port 9001 --site-url http://link-demo-airline.localhost:8080 &
python -m nsdeploy examples/link_demo_travel_agency.hocon \
  --port 9002 --site-url http://link-demo-travel-agency.localhost:8080 &

# Expose both sites through one port.
python -m nsdeploy gateway --base-domain localhost --port 8080 \
  --route link_demo_airline=http://127.0.0.1:9001 \
  --route link_demo_travel_agency=http://127.0.0.1:9002
```

Open <http://link-demo-airline.localhost:8080/> or
<http://link-demo-travel-agency.localhost:8080/>. The backend site, facade, and MCP
tool listeners remain loopback-only; only the gateway port needs to be exposed.
Unknown hostnames are rejected, and startup fails if two network names normalize to
the same subdomain.

For Azure or another TLS-terminating ingress, point wildcard DNS such as
`*.agents.example.com` at the ingress, map its public HTTPS listener to the gateway's
single internal port, start the gateway with `--bind 0.0.0.0`, and give each site an
external origin such as `--site-url https://link-demo-airline.agents.example.com`.
The gateway itself speaks HTTP; TLS can terminate at the platform ingress.

By default it runs on a deterministic **mock** LLM (no key needed). For real output,
open **⚙ BYOK settings** in the page and enter your API key + model — calls route
through the same-origin `/byok/v1` CORS proxy to your provider. A saved profile with
a real key is automatically moved off the site's mock `/v1` route. The header reports
a real LLM only after the endpoint returns a verifiable, non-mock model response;
routing errors are shown as errors rather than silently falling back to mock.

**BYOK guarantee.** A served site never holds or uses an LLM key configured on the
host. `/v1` is a keyless local mock that makes no network calls; `/byok/v1` forwards
exactly the `Authorization` header the visitor entered to `--upstream` and nothing
else; the public `/mcp` facade refuses real requests without caller BYOK headers and
is started with provider credentials (`OPENAI_*`, `ANTHROPIC_*`, `*_API_KEY`, …)
scrubbed from its environment. Deploy-time theming is the only step that reads
`OPENAI_API_KEY`, and it finishes before the server starts. `--facade-key` is accepted
for compatibility and ignored.

## Self-contained static bundle

Use `--static-bundle` to produce a webroot that can be copied to a conventional
static host without installing Python or nsDeploy there. The command form is:

```bash
python -m nsdeploy <network.hocon> \
  --static-bundle \
  --out <webroot-directory> \
  [--site-url https://host.example/optional/base/path]
```

`--static-bundle` implies generate-only mode; it does not start a server. For
example:

```bash
python -m nsdeploy examples/link_demo_travel_agency.hocon \
  --static-bundle --out ./dist/travel
```

Preview that bundle with any ordinary static server:

```bash
python -m http.server 8080 --directory ./dist/travel
```

Then open <http://127.0.0.1:8080/>. To publish a canonical identity for links and
private stewards, include the final webroot URL when building:

```bash
python -m nsdeploy examples/link_demo_travel_agency.hocon \
  --static-bundle \
  --out ./dist/travel \
  --site-url https://agents.example.com/travel
```

After uploading `./dist/travel/` as that webroot, the public network URL is:

```text
https://agents.example.com/travel/link_demo_travel_agency
```

A generated private steward calls the static network with the equivalent coded-tool
arguments:

```json
{
  "site_url": "https://agents.example.com/travel/link_demo_travel_agency",
  "request": "Find me a flight from San Francisco to New York next Friday."
}
```

The steward fetches `agent-manifest.json` and the selected network JSON, then runs
the network privately. Its LLM key is sent only to the steward's configured LLM
upstream, never to the static host.

The output includes the browser runtime, a browser-native deterministic mock,
relative page assets, browser-local unresolved links, and optional `_headers` /
`.htaccess` hosting configuration. Python coded tools are intentionally omitted.
External MCP servers are contacted directly and therefore must permit browser CORS.
Real BYOK calls go directly to the OpenAI-compatible router selected in settings;
that router must likewise permit browser CORS. The public MCP facade is marked
unavailable because accepting inbound MCP calls requires an application server.
The generated private steward remains usable: it downloads the public network JSON
and runs it in the private Neuro-SAN environment, so the static host needs no MCP
facade or other server-side process.

When `--site-url` is omitted, the static bundle is origin-neutral and can be moved
between hosts. Supplying `--site-url` publishes a canonical URL for link discovery.
The static host only needs to serve files over HTTP(S). When a browser-hosted agent
on another domain will load the network, responses must include
`Access-Control-Allow-Origin: *`; server-side private stewards do not require CORS.
The sandbox worker also needs the CSP shown in the generated `STATIC_HOSTING.md`.
The included `_headers` and `.htaccess` cover hosts that support those standard
configuration formats. Hosts that ignore both files need the equivalent headers
configured in their control panel.

## Cailville multi-site demo

[`cailville/`](cailville) contains fourteen base household,
business, broker, civic, and commerce-arbiter agent networks, their decentralized link sidecars, and
an interactive town map. Start the complete demo from the repository root:

```bash
./cailville/launch_all.sh
```

For real private-steward execution, use the same OpenAI key already used by the
private Neuro-SAN server, or set the steward-specific variables explicitly:

```bash
export NSDEPLOY_STEWARD_BYOK_API_KEY="your-key"
export NSDEPLOY_STEWARD_BYOK_MODEL="gpt-4o"
export NSDEPLOY_STEWARD_LLM_UPSTREAM="https://api.openai.com/v1"
./cailville/launch_all.sh
```

The launcher does not install that key in any public site. The private steward uses
it locally while running downloaded, code-free public network definitions; the key
is never sent to the sites that publish those definitions. MCP facades remain a
compatibility fallback for older sites.

To verify the complete path, select
`deneman_place/deneman_place_private_steward` in nsFlow and submit:

```text
Plan an 80-person wedding in Cailville. Find venue, catering, lodging,
transportation, neighbor assistance, and any required permits.
```

Approve the steward's proposed contacts when prompted. A successful run fetches the
contacted sites' manifests and network JSON, records `200 OK` responses from the
private steward's configured LLM upstream, and completes without `tool_error: true`,
authentication errors, or a steward timeout. Public-site logs must not contain the
BYOK authorization header or key value. The sites contacted are chosen by the agent
from its directory and the public links it discovers, so transport success does not
guarantee that one turn will cover every requested business category.

The launcher uses `.venv/bin/python` or `venv/bin/python` when available, starts the sites on ports
8091-8103 plus the commerce arbiter on 8105 (and any added sites), waits for every site,
and then opens `cailville/cailville.html`. Logs are
written to `.nsdeploy/cailville-logs/`. Its runtime BYOK proxy defaults to OpenAI and
theme generation defaults to `gpt-5.6`; override those with `NSDEPLOY_UPSTREAM`,
`NSDEPLOY_THEME_MODEL`, or `NSDEPLOY_PYTHON`. Existing editable themes are preserved;
set `NSDEPLOY_THEME_REFRESH=1` only when you deliberately want to replace them.
Public bundles are written under `.nsdeploy/cailville/`, and the generated private
steward manifest is `.nsdeploy/cailville/manifest.hocon`. Its entries are relative
to the manifest directory, for example
`harbor_guide/harbor_guide_private_steward.hocon`, so the manifest remains readable
and portable with the bundle directory. To run those stewards in a standard
Neuro-SAN server, set `AGENT_MANIFEST_FILE` to that manifest.
`launch_all.sh` also starts the private Neuro-SAN studio from
`/Users/754339/projects/cailville-private` (using its installed
`neuro-san-studio` package), points its `AGENT_MANIFEST_FILE` at this generated
manifest, and opens nsFlow on port `4174`.
It waits for both the Neuro-SAN HTTP server and nsFlow to be ready before opening
the demo, avoiding an initial concierge connection race.
Override the private project or ports with `NSDEPLOY_PRIVATE_STUDIO_DIR`,
`NSDEPLOY_PRIVATE_STUDIO_HTTP_PORT`, `NSDEPLOY_PRIVATE_STUDIO_GRPC_PORT`, and
`NSDEPLOY_PRIVATE_STUDIO_NSFLOW_PORT`.

The existing Cailville port mode is also the default. To expose every public site
through one local gateway port instead, enable subdomain routing explicitly:

```bash
NSDEPLOY_ROUTING=subdomain \
NSDEPLOY_BASE_DOMAIN=localhost \
NSDEPLOY_GATEWAY_PORT=8080 \
./cailville/launch_all.sh
```

This publishes URLs such as <http://harbor-guide.localhost:8080/> and rewrites the
generated Cailville map, public-site directory, manifests, and runtime link sidecars
to use those origins. The checked-in port-based link sidecars are not modified.
For a cloud ingress, additionally set `NSDEPLOY_GATEWAY_BIND=0.0.0.0`,
`NSDEPLOY_PUBLIC_SCHEME=https`, and `NSDEPLOY_PUBLIC_PORT=443`; the internal
`NSDEPLOY_GATEWAY_PORT` can remain an unprivileged port such as `8080`.

To run the agents with Docker Model Runner instead, explicitly select its upstream
and enter one of the exact IDs returned by its `/models` endpoint in BYOK settings:

```bash
NSDEPLOY_UPSTREAM=http://localhost:12434/engines/v1 \
NSDEPLOY_STEWARD_BYOK_API_KEY=x \
NSDEPLOY_STEWARD_BYOK_MODEL="exact-model-id-from-models" \
./cailville/launch_all.sh
```

For a fast functional test, skip theme generation entirely:

```bash
NSDEPLOY_THEME=0 ./cailville/launch_all.sh
```

To deliberately replace every editable theme with a fresh LLM design:

```bash
NSDEPLOY_THEME_REFRESH=1 ./cailville/launch_all.sh
```

`NSDEPLOY_THEME=0` takes precedence over the theme model and refresh settings.

Stop the complete demo from another terminal:

```bash
./cailville/stop_all.sh
```

### Test Cailville in a browser

With Cailville running, `tests/cailville_browser.ts` opens the map and every site in
headless Chromium. It also tests the airline, the travel agency linked to it with
`--link`, and the travel agent system, which it starts itself on 8192, 8191 and 8120.
On each site it sends the first sample query, approves the partner sites the agent
asks to contact, and waits for the run to finish. Then it checks the site's execution
trace. It runs on the mock LLM by default, so no key is needed.

It tests the runtime on the neuro-san TS package, which Cailville runs by default, and
every check passes there. With the original runtime
(`USE_TS_PACKAGE=0 ./cailville/launch_all.sh`), 12 of the Cailville sites fail,
because they stop at the original runtime's per-query limit of 24 agent invocations
before every agent has run.

It first builds the runtime from the TS package version `runtime-build/package.json`
pins, and runs `npm ci` there if `npm ls` says what's installed doesn't match. GitHub Packages
needs a token for that, for example `export NODE_AUTH_TOKEN=$(gh auth token)`. To test
a new package release, run
`npm install @cognizant-ai-lab/neuro-san-ts-package@<version>` in `runtime-build/`,
which updates `package.json` and the lock, then run the test.

```bash
npm install
npx playwright install chromium
npm run test:cailville              # everything
npm run test:cailville -- 8091 8191 # just these ports
npm run test:cailville -- scenarios # just the checks below for when the user says no
npm run test:cailville -- mcp       # just the MCP checks
npm run test:cailville -- live      # just the checks on a running turn
HEADED=1 npm run test:cailville -- 8091  # watch it in a visible browser
TEST_REAL_LLM=1 npm run test:cailville -- 8191  # use $OPENAI_API_KEY instead of the mock
```

A site fails if:

- the page shows an error or a request fails
- the run doesn't finish
- any step in the trace ends in an error
- it asks to link an agent, since every agent on these sites is defined or linked
- on the mock, any agent the front man can reach never ran (the mock calls every tool)
- the travel agency never calls the airline

Then it checks what happens when the user doesn't go along with the agent. It uses
`tests/fixtures/open_link_travel_agency.hocon`, a travel agency that doesn't define the
airline, on 8193:

- cancel the link prompt: the run finishes and the agent is told the airline isn't linked
- enter the airline's URL in the link prompt: the airline gets called
- decline the airline contact on the travel agency: the airline is never called, and the agent is told
- pick the real router with no key: nothing reaches the router, and the run ends asking for a key

It checks MCP on the travel agent system on 8120, which has its own coded tools hosted
as MCP servers under `/_mcp` and You.com's MCP server behind the site's `/ext-mcp` proxy:

- call an MCP tool: a call goes out and comes back with something, and You.com's notifications show as the tool's progress
- decline an MCP call: nothing reaches an outside MCP server, discovery included, while the site's own MCP tools still run

And it checks a turn while it runs, on the same site:

- show what's happening: the chat's status line shows what the agents are doing and is gone once the answer is, and the answer's text streams into the trace
- steer a running turn: guidance sent while the front man's first model call runs shows as a steering message, cancels that call, and goes into the calls after it

A real LLM run uses OpenAI's `gpt-4o` to keep the cost down, and `TEST_MODEL=<id>` picks another model. It skips the MCP checks and the checks for when the user says no, which rely on the mock's answers, but runs the checks on a running turn, since steering has to work on a real model too.
Screenshots go to `.nsdeploy/cailville-browser-test/`.

### Book through Butterpink's private steward in nsFlow

The Cailville map includes **Cailville Commerce Arbiter**, connected to **Seabreeze
Inn** and **Butterpink Family**. Booking takes place in the existing private
steward conversation in **nsFlow**, reached through the map's **Private stewards**
toggle. There is no separate commerce page, form, pairing code or checkout.

Ask Butterpink's private steward to book a night at the Inn for a stated USD maximum.
It collects any missing date or budget, creates a fixed mandate at the public
arbiter, and engages the Inn's coded seller adapter over HTTP. The Inn receives
stay details and a scoped seller capability, never the raw private ceiling. The
arbiter receives the sealed policy bid and computes the binding offer. The steward
presents that offer in chat; a subsequent **Confirm booking** reply approves the
exact offer and returns a simulated receipt in the same conversation.

The implementation uses the actual SQLite arbiter from
[babakatwork/agent-commerce-demo](https://github.com/babakatwork/agent-commerce-demo),
pinned to commit `47fe668ff19c23cf1294685ef122d8ca9fad63e1`. Its engine is vendored
unchanged with the Apache license and notice; see
[`PROVENANCE.md`](nsdeploy/commerce/PROVENANCE.md). nsdeploy supplies the fixture
catalogue, HTTP adapters, private coded tool and chat middleware. The negotiation
and ledger are coded execution; the private LLM interprets the request and calls
tools. Public sites retain their usual chat, discovery and MCP functionality.

The fixture is **one night for two adults** with parking, Wi-Fi, one local activity,
taxes and fees. It excludes meals and travel to Cailville. Catalogue price:
**$525**. A **$500** ceiling produces **$477.50** under equal-weight Nash bargaining;
**$450** produces **NO_AGREEMENT**. Other dates must be today or later. Other stay
lengths or party sizes require a different catalogue fixture; the steward should
explain that scope instead of silently changing the request. All amounts are
integer USD cents. Offers expire 15 minutes after negotiation.

#### Manual check before pushing

1. Launch Cailville normally, with its existing private studio and model credentials:

   ```bash
   NSDEPLOY_THEME=0 ./cailville/launch_all.sh
   ```

   The launcher opens the map and starts nsFlow. `NSDEPLOY_THEME=0` preserves the
   editable themes and skips paid theme generation. The private studio uses its
   configured model credentials; booking adapters do not use or forward LLM keys.
2. On [`cailville/cailville.html`](cailville/cailville.html), enable **Private
   stewards**. Click the private steward badge beside **Butterpink Family**. It
   opens nsFlow with `butterpink_family/butterpink_family_private_steward` selected.
   The equivalent direct link is
   [Butterpink private steward](http://127.0.0.1:4174/?network=butterpink_family%2Fbutterpink_family_private_steward).
3. Start a new chat and ask:

   ```text
   Book a night at Seabreeze Inn for two adults on 2026-12-15 for no more than $500.
   ```

   Use a future date if this example date has passed. You can instead start with
   “Book a night at the Inn for under $500”; the steward should ask for the date.
   Expect an arbiter-issued **$477.50** offer, the correct dates and inclusions,
   cancellation terms, and an invitation to confirm. Nothing is held or spent yet.
4. Reply **Confirm booking** in that chat. Expect a **SIM-...** receipt, **$477.50**
   paid in the simulation and the same dates. Ask “What is my booking status?”:
   the same receipt should return. Repeating confirmation must not charge twice.
5. In a new chat, repeat with **$450**. Expect no agreement and no booking. Try a
   **$500** offer followed by **Cancel the offer**. Ask for status: it should be
   cancelled with zero spent. Changing the budget or date on an active offer
   requires cancelling it first. An offer older than 15 minutes cannot be approved.
6. Verify other private-steward requests, public-site chat, map filters and links
   still behave normally. The arbiter and Inn public pages explain the mechanism;
   they have no commerce banner or checkout. `/commerce` returns 404.

The private graph keeps its booking context between nsFlow turns through a single
opaque SlyData handle. The private middleware reads the new human message, records
the user's dollar ceiling, and only permits approval of an offer already presented
in an earlier turn. A model-supplied approval flag or a request to settle during the
initial negotiation cannot bypass this. Canonical offers, status and receipts are
rendered from coded results, rather than model-invented prices or confirmations.
For predictable confirmation use **Confirm booking**; ambiguous replies do not
approve a purchase. Ordinary public MCP gateway calls remain available to this
steward, and other generated stewards are unchanged.

#### Verification and deployment state

```bash
python -m unittest discover -s tests -v
npm test
```

The commerce tests execute real private Neuro-SAN graphs with a scripted test
model and real local HTTP calls through the arbiter and Inn. They test natural
booking requests, follow-up confirmation and status, missing details, no agreement,
cancellation, premature or negated approval, a lowered budget, credential/session
isolation, forged offers, expiry, inventory failure, retries and persistence. Existing BYOK, MCP, linking,
resolver, theme, launcher and browser-runtime regressions remain in the full suites.
The scripted model lives only in tests. Normal nsFlow uses the configured private LLM.
The chat integration was also exercised in nsFlow 0.6.17 with Neuro-SAN 0.6.92,
using a temporary scripted-model setting and the real private tool, arbiter and Inn.
A live-model manual check still requires the private studio's model credentials.

The launcher provisions an owner-only local credential file at
`.nsdeploy/cailville/.commerce/steward.key`, shared by the arbiter and private studio.
It also stores the ledger at `.nsdeploy/cailville/.commerce/commerce_arbiter.sqlite`.
Both are outside public site directories. Runtime credentials and per-chat session
capabilities are never model arguments, tool responses or seller messages. The
arbiter API rejects browser-origin writes and unauthenticated private actions.
Public seller callbacks require separate scoped engine capabilities.

`NSDEPLOY_COMMERCE_KEY_FILE` overrides the shared credential file; set the same
protected file for the arbiter and private runtime. `NSDEPLOY_COMMERCE_ARBITER_URL`
sets the private runtime's arbiter origin (default `http://127.0.0.1:8105`). The tool
honors `NSDEPLOY_STEWARD_DENY_ORIGINS`. Models cannot choose these settings. Existing
subdomain routing works through the same internal backend; update the HOCON
`commerce.seller_backend` and `commerce.arbiter_backend` if backend ports move.

This is a trusted-host simulation: no real room reservation or money transfer,
refund API, production identity provider, or distributed private-session store.
Keep nsFlow and its SlyData private. The private runtime holds booking bindings in
memory for 24 hours; restarting it requires a new chat. The arbiter ledger persists,
but this example does not recover old chat bindings after a private-runtime restart.
The audit is an application event log, not tamper-proof evidence. Raw ceilings and
floors are withheld from the opposing party, although prices can reveal information
by inference. The old standalone checkout has been retired; its historical ledger
rows, if any, are preserved but its browser sessions no longer authorize actions.

### Add a public site to Cailville

Use the Cailville workflow to design a site, infer a small set of useful public-network
connections, add it to the map, generate its private steward, and launch the complete
community:

```bash
python -m nsdeploy cailville examples/community_bank_front_office.hocon
```

The HOCON is optional. With no positional argument, nsDeploy selects the most recently
modified `*.hocon` file directly inside `~/Downloads`:

```bash
python -m nsdeploy cailville
```

Additions are cumulative by default. Start this demo from the 14-site base map while
still adding the requested site with `--base-map`, or restore only the base map with
`--reset-map`:

```bash
python -m nsdeploy cailville examples/community_bank_front_office.hocon --base-map
python -m nsdeploy cailville --reset-map
```

The first added site defaults to port `8088`; later additions receive the next unassigned
port. `--no-launch` performs generation, linking, map revision, and steward generation
without starting the long-running demo. `--no-theme` and `--no-ai-connections` provide a
keyless deterministic path.

The existing site-generation command can opt into the same community update while retaining
full control over its normal flags:

```bash
python -m nsdeploy examples/community_bank_front_office.hocon \
  --port 8088 --upstream https://api.openai.com/v1 \
  --theme --theme-model gpt-5.5 --theme-refresh \
  --add-to-cailville
```

Use `--cailville-base-map` with `--add-to-cailville` to discard prior demo additions first.
The base community lives in `cailville/community.base.json`; the active cumulative state is
`cailville/community.json`. `launch_all.sh` reads the active state, so newly added sites and
both sides of inferred public-network relationships are launched automatically. Public sites
receive only their inferred peer links, while every private steward receives the directory of
all currently active Cailville public sites. Returning to the base map also removes prior demo
additions from the private-steward manifest.

## What it does (pipeline)

1. **Resolve** the HOCON with pyhocon, includes relative to the studio root, so
   `include "registries/aaosa.hocon"` and `${aaosa_call}`/`${demo_mode}` resolve
   exactly as neuro-san would resolve them.
2. **Classify & dependency-check** every entry in `tools`:
   - LLM agents (run in the browser),
   - `toolbox`/`class` tools resolved against the studio's `toolbox_info.hocon` +
     `coded_tools/` → **hostable** (can run as MCP) or **missing**,
   - URL tools, classified as either **external MCP servers** or **public agent
     networks**,
   - and it flags **`demo_mode`** agents and **missing includes**.
3. **Host** each hostable tool as a standalone **FastMCP** streamable-HTTP server
   (with CORS), exposing its `CodedTool.invoke(args, sly_data)` as an MCP tool whose
   input schema is built from the tool's JSON-Schema parameters. The launcher picks
   an available private port for each process, avoiding collisions between sites.
4. **Rewrite** the resolved network (a copy): each hostable tool reference becomes its
   stable same-origin `/_mcp/<i>/mcp` URL; each **external MCP** URL becomes a proxy URL
   (`/ext-mcp/<i>/mcp`) so the browser can call it without CORS; each non-MCP HTTP(S)
   URL is preserved as a **public agent network**; and missing tools are dropped. This
   removes any assumption of a local neuro-san server—tools are reached over MCP or
   by loading a public agent network into the browser.
5. **Generate** `index.html` + `theme.css` + `site.js` + `agent-manifest.json` +
   `<network>.network.json` + `agent-mcp.json` + `<network>_private_steward.hocon` +
   `theme.json` from the editable site source and network.
6. **Serve** one static origin (site + the browser runtime), a mock LLM router at `/v1`, a BYOK proxy at `/byok/v1`, and an
   local-MCP proxy at `/_mcp/<i>/mcp`, an external-MCP proxy at
   `/ext-mcp/<i>/mcp`, plus the private local MCP server subprocesses. Every site
   also publishes a server-side MCP facade at `/mcp` for legacy private stewards.
   The facade propagates a per-request visited-site trace and bounded public-call
   budget, preventing cyclic public-site links from expanding indefinitely.
   With the no-key mock upstream, each public agent takes one deterministic tool
   hop so demo requests remain bounded; a configured LLM upstream controls normal
   multi-step tool selection.

## Private stewards and open-web reachability

Every generated public site includes `<network>_private_steward.hocon`. It is a standard
Neuro-SAN network for the site's operator, backed by the reusable
`nsdeploy.steward.PublicAgentNetworkGateway` coded tool. The gateway accepts any
public nsDeploy network URL, downloads `agent-manifest.json` and the selected
`<network>.network.json`, validates that they contain data-only agents, and runs the
network inside the private environment. It falls back to the site's `invoke_network`
MCP tool for older deployments that cannot be loaded this way. Install nsdeploy in
the same Python environment as the standard Neuro-SAN server, or add this repository
to that server's `PYTHONPATH`.
When a network has linked public sites, the generated steward includes their exact
URLs in its private directory and is instructed not to invent hostnames. Unknown
public sites remain reachable by supplying their URL explicitly.
Generated private stewards allow up to 3600 seconds for multi-site fan-out requests;
adjust `max_execution_seconds` in the generated steward HOCON if a deployment needs
an even longer workflow. Each public-site call is bounded to 720 seconds by
`launch_all.sh`; override that with `NSDEPLOY_STEWARD_SITE_TIMEOUT_SECONDS` when a
trusted public network needs more time. The public facade bounds nested site calls
to 480 seconds by default; override that with `NSDEPLOY_FACADE_SITE_TIMEOUT_SECONDS`.
Those bounds are also applied to compatibility MCP clients' long-lived SSE reads,
replacing the library default of 300 seconds so an active request is not dropped
mid-run.

Public sites are open-web reachable by default, like ordinary HTML links. The
generated manifest declares `peer_policy.mode = "open"`; it does not turn published
links into an authorization allow-list. A private steward can deny origins with:

```bash
export NSDEPLOY_STEWARD_DENY_ORIGINS="https://untrusted.example,http://127.0.0.1:9999"
```

The private steward uses `NSDEPLOY_STEWARD_BYOK_API_KEY` (falling back to
`OPENAI_API_KEY`), `NSDEPLOY_STEWARD_BYOK_MODEL`, and optionally
`NSDEPLOY_STEWARD_LLM_UPSTREAM` for its local execution. Those credentials are never
included in public manifest/network requests, tool arguments, prompts, results, or
local and third-party MCP calls. In legacy facade mode they are sent as sensitive
MCP transport headers and propagated only between public facades. A real facade
request without caller credentials is rejected, and the facade subprocess is
started with provider credentials scrubbed from its environment (`scrubbed_env` in
`nsdeploy/launcher.py`).
Set the facade upstream explicitly to `mock://nsdeploy` only for a deterministic
keyless demo. The browser `/byok/v1` path remains unchanged.

## Linking separately deployed agent networks

A caller represents a prospective remote network as a referenced, leaf
`demo_mode` agent. Before linking, that leaf provides the local fake-data demo.
At link time nsDeploy removes the demo leaf and rewrites all references to the
callee site's network URL. The demo leaf's name must match the callee's HOCON
filename/network name or its front-man name.

The runtime uses a **fetch-and-run-locally** composition model: after consent it
fetches the target site's public manifest and network definition, interprets that
network inside the caller's browser, and returns the result through the caller's
existing orchestration loop. A linked network is never invoked as a remote agent
execution service. It inherits the caller's active LLM router and model settings
(including the caller's mock router for keyless demos); BYOK keys are never sent to
the callee site.

The callee is an ordinary standalone network. It needs no import declaration,
caller name, `link_aliases`, or other knowledge of who might link to it. Every
site publishes only its own identity in `/.well-known/nsdeploy.json`, and every
binding is stored by the calling site. There is no registry, discovery service, or
required deployment order.

For example, the caller can contain:

```hocon
tools = [
  {
    name = "travel_concierge"
    instructions = "Plan travel and call link_demo_airline for flights."
    tools = ["link_demo_airline"]
  },
  {
    name = "link_demo_airline"
    instructions = ${demo_mode} "Act as the airline for this local demo."
    tools = []
  }
]
```

The callee can simply be `link_demo_airline.hocon`; it does not mention the
caller or linking at all.

Link local HOCONs by supplying the URL where each target will be hosted:

```bash
python -m nsdeploy link \
  examples/link_demo_travel_agency.hocon \
  examples/link_demo_airline.hocon \
  --site link_demo_travel_agency=http://127.0.0.1:8091 \
  --site link_demo_airline=http://127.0.0.1:8092
```

This writes `<source>.links.json` sidecars. Deploy normally; nsDeploy loads the
matching sidecar automatically. To link a new HOCON to an already hosted peer:

```bash
python -m nsdeploy link examples/link_demo_travel_agency.hocon \
  --peer http://127.0.0.1:8092
```

The reverse order works too. If the travel caller is already hosted and the airline
is the newly supplied HOCON, the linker installs the outbound binding directly on
the travel site:

```bash
python -m nsdeploy link examples/link_demo_airline.hocon --site link_demo_airline=http://127.0.0.1:8092 --peer http://127.0.0.1:8091
```

A binding can also be supplied directly:

```bash
python -m nsdeploy examples/link_demo_travel_agency.hocon --port 8091 \
  --link link_demo_airline=http://127.0.0.1:8092/link_demo_airline
```

For a non-local deployment, pass `--site-url https://public.example.com` so the
published manifest contains the externally reachable origin. Links may also be
hard-coded under a top-level HOCON
`links { link_demo_airline = "https://site.example/link_demo_airline" }` block.

A referenced demo leaf continues to run locally until `nsdeploy link`, `--link`,
or a HOCON `links` entry replaces it. A caller may also put the published network
URL directly in an agent's tool list, with no link sidecar or `links` entry:

```hocon
tools = ["http://127.0.0.1:8092/link_demo_airline"]
```

Non-MCP HTTP(S) tool URLs are treated as public agent networks: after user consent,
the browser fetches their public manifest and network definition and runs them
locally. The URL's final path component must match the published network name.

Truly undefined references are still
supported as interactive link slots: when called, the browser asks for the target
site URL and stores the resulting outbound link. Without a local HOCON, a
hard-coded link, or an explicit peer URL, the linker cannot discover an unknown
site.

## Grounding & `demo_mode`

`nsdeploy` prints a dependency report at deploy time. Agents whose instructions use
`${demo_mode}` are listed under **"DEMO-MODE agents — NOT GROUNDED"**: they fabricate
realistic-looking answers instead of using real data/tools. **Ground them later** by
giving each a real tool/data source and removing `demo_mode` from its instructions.
Tools that can't be resolved from the repo are likewise reported and dropped.
**External MCP servers are kept** — proxied same-origin so the
browser can call them; whether a given call succeeds then depends on that remote
server (reachability/auth) and the user's run-time consent.

## Generative UI (CRUSE)

By default nsdeploy **injects a domain-agnostic CRUSE directive into every agent's
instructions** (in the generated copy — your source HOCON is untouched). CRUSE
chooses a useful combination of chat, formatted reports, tables, bar/line charts,
presentational HTML, and optional form/choice/confirm/info components. It does not
require a form for every question. Opt out of prompt injection with `--no-cruse`.

Each child returns its answer **and a presentation proposal to its parent**. Each
parent is instructed to consolidate its children's proposals during its normal
response: merge redundant questions, use known answers, preserve distinct needs,
and choose the right presentation for the current request. This applies across
local agents and linked networks. Only the
final root composition is rendered; child proposals remain in the developer trace.
Exact duplicate components are also removed by the runtime; semantic consolidation
is performed by the model, so quality still depends on the selected model.

The welcome widget remains an optional starting point. Users may ignore it, answer
in chat, or supplement submitted form values in later chat turns. Unsubmitted
drafts are not sent. The history includes the final presentation, and interactions
carry their turn/component IDs and typed values so follow-ups retain context.

New output uses one `cruse-ui` JSON fence containing
`{"version":1,"components":[...]}`. Legacy single-widget fences remain supported.
Charts include a text summary and expandable data table. HTML is limited to
sanitized semantic markup; scripts, CSS, embeds, resources and HTML input controls
are not supported. See [the CRUSE protocol](docs/cruse.md) for shapes and tests.

Presentations are authored by the **LLM**, so the deterministic mock router does
not exercise semantic consolidation. Regenerate a deployment to install updated
CRUSE prompts. Theme prompt version 9 describes optional forms and rich responses;
existing editable themes are preserved until explicitly refreshed.

## Look & feel (optional LLM-designed layout)

By default the site uses a fixed template. With a key, the LLM **designs a distinctive
landing page** from the network's identity — not just a recolor: a domain-fit layout
(hero, sections, panels), palette, typography, brand/icon/tagline, and an optional
welcome form. A sports assistant feels sporty, a recipe app culinary, etc.:

```bash
# default look (no key) — unchanged
python -m nsdeploy net.hocon

# LLM-polished with OpenAI (deploy-time key)
OPENAI_API_KEY=sk-…  python -m nsdeploy net.hocon --theme [--theme-model gpt-5.6]

# add project-specific design direction
OPENAI_API_KEY=sk-…  python -m nsdeploy net.hocon --theme \
    --theme-prompt "Use a restrained editorial layout with warm paper tones"

# LLM-polished with a LOCAL model (Ollama) — does NOT touch the runtime
python -m nsdeploy net.hocon --theme --theme-model qwen2.5:7b --theme-key x \
    --theme-upstream http://127.0.0.1:11434/v1

# pin a theme (no LLM, no key, reproducible)
python -m nsdeploy net.hocon --theme-file theme.json
```

Theming is a **deploy-time** step. It uses `--theme-upstream` (which defaults to
OpenAI) + the deploy-time key (`$OPENAI_API_KEY` / `--theme-key`). Runtime
`--upstream` is independent and only controls the deployed app's BYOK proxy. Set
`--theme-upstream` explicitly when you want theming on a different provider — e.g.
theme with a local Ollama (`--theme-upstream http://127.0.0.1:11434/v1`) while the
deployed app still calls Docker Model Runner or OpenAI-compatible BYOK at runtime.
The model entered in the runtime settings must be an exact model ID published by
that runtime upstream; a theme model being available does not make it available to
the runtime. For Docker Model Runner, inspect the catalog with:

```bash
curl http://localhost:12434/engines/v1/models
```

The LLM authors the page's **CSS + HTML composition**, but it's treated as untrusted
and **strictly sanitized**: only safe presentational tags/attributes survive (no
`<script>`, `on*` handlers, `<iframe>`/`<form>`/`<svg>`; CSS stripped of `@import`,
`expression()`, unsafe `url()`). A generated layout places three empty runtime mounts
inside `#app`: the compact header, the primary chat, and agent activity. This lets the
designer choose an inline rail, stacked panel, overlay, or native `<details>` pull-out
instead of inheriting one fixed split. The runtime fills those mounts and protects page
scrolling and CRUSE form reachability. Older cached themes with one empty `#app` keep
the legacy resizable split layout. On any problem (no key, error, invalid/unsafe output,
missing or incomplete mounts), nsdeploy **falls back to the default template**, so a
creative layout cannot break the app or the keyless experience.

The first deploy creates an **editable source package** beside the HOCON:

```text
sites/<network>/
  layout.html   # page composition and runtime mount slots
  theme.css     # site-owned visual design
  site.js       # optional behavior, run after the agent UI boots
  theme.json    # brand, palette, typography, and welcome metadata
  assets/       # optional local images and other static assets
```

Use `--site-dir DIR` to put it elsewhere. Normal deploys read these files and never
overwrite them; `.nsdeploy/<source-dir>/<network>/` remains disposable build output.
The containing `.nsdeploy/<source-dir>/manifest.hocon` is regenerated to list every
generated private steward in that bundle group. Set `AGENT_MANIFEST_FILE` directly to
that file when running the standard Neuro-SAN server. A normal
`--theme` run also uses an existing package instead of calling the model again. The
LLM result is therefore a starting point: edit the source package and redeploy. The
generated `site.js` exports an optional `customize({ root, runtime })` hook, and any
files under `assets/` are copied into the built site.

Theme proposals are also cached under `~/.cache/nsdeploy/themes/`. `--theme-refresh`
is the explicit destructive refresh for `layout.html`, `theme.css`, and `theme.json`;
it preserves `site.js` and `assets/`, and it preserves the current design if the LLM
does not return a valid replacement. The theming key is supplied by *you* at deploy
time; end users still need no key. `--theme-prompt` appends custom design direction to
the generator prompt and is included in the theme cache key. Flags: `--theme`,
`--theme-model`, `--theme-upstream`, `--theme-key`, `--theme-prompt`, `--theme-file`,
`--theme-refresh`, `--site-dir`.

> Theme generation defaults to `gpt-5.6`, whose design judgment produces more polished
> layouts. Use `gpt-5.6-terra` or `gpt-5.6-luna` for lower-cost generation, or a local
> model such as `qwen2.5:7b`. Whatever the model emits, the assistant stays usable and
> the build is safe.

### Regenerating the theme

Generated themes are cached under `~/.cache/nsdeploy/themes/` (one `<digest>.json`
per design). Once editable source exists, normal runs use it. To deliberately replace
the editable HTML/CSS/metadata with a fresh design:

```bash
# Re-ask the LLM, replace the cached proposal, and refresh the editable theme files
python -m nsdeploy net.hocon --theme … --theme-refresh

# Refresh an existing editable theme with new design direction
python -m nsdeploy net.hocon --theme --theme-refresh \
    --theme-prompt "Keep the editorial structure, but use a dark navy palette"

# Or wipe the cache entirely (all designs regenerate on the next run)
rm -rf ~/.cache/nsdeploy/themes/
```

The cache key is a hash of the **network identity + model name + prompt version**, plus
the custom theme prompt when one is supplied. Once source has been created, changing
the model does not replace user edits; use `--theme-refresh` when that is really what
you intend.

## Use a local model (Ollama) — no key, no cloud

If you'd rather not use a cloud API key, run a model **locally** with
[Ollama](https://ollama.com) and point nsdeploy at it. The same local endpoint works
for **deploy-time theming** (`--theme-upstream`) and for **running the agents** (paste
it into the page's BYOK settings) — nothing leaves your machine.

The bundled helper installs nothing surprising: it checks for Ollama, starts the
server if needed, pulls the model, and prints the exact deploy command.

```bash
# pull + serve qwen2.5:7b (default), or pass another model name
scripts/serve-local-model.sh              # e.g. scripts/serve-local-model.sh llama3.2:3b
```

Prefer to do it by hand? Three steps:

```bash
# 1. Install Ollama
#    macOS:  brew install ollama    (or download from https://ollama.com/download)
#    Linux:  curl -fsSL https://ollama.com/install.sh | sh

# 2. Serve it and pull a model (Ollama listens on 127.0.0.1:11434)
ollama serve &                 # leave running; skip if the app already started it
ollama pull qwen2.5:7b

# 3. Deploy, theming with the local model (the key is ignored by Ollama)
python -m nsdeploy examples/soccer_world_cup_assistant.hocon --port 8080 \
    --theme --theme-model qwen2.5:7b --theme-key x \
    --theme-upstream http://127.0.0.1:11434/v1
```

To also **run the deployed agents** on the local model, open **⚙ BYOK settings** in the
page and set Router base URL `http://127.0.0.1:11434/v1`, Model `qwen2.5:7b`, and any
non-empty API key. For local deploy-time theming, pass
`--theme-upstream http://127.0.0.1:11434/v1`; `--upstream` remains the runtime BYOK
proxy target.) Bigger local models give richer layouts; `qwen2.5:7b` is a good
low-footprint default (~4.7 GB).

## The agent loop

Agents run on neuro-san's `DirectAgentSession`, not on a reimplementation of it.
The package is built for the browser: its Node stand-ins and third-party libraries are
bundled into it. [`runtime-build/`](runtime-build) builds nsdeploy's adapters over it with
Vite into `nsdeploy/runtime/ts-package/generated/`. That folder is build output, like a `dist`, so
it is not checked in: build it before running nsdeploy or building a wheel, which ships
whatever is there. The layout:

- `browser/`: our code from `runtime-build/` (the agent network and session adapters),
  unminified. `browser/neuro-san.mjs` is the entry.
- `neuro-san/neuro-san.mjs`: the package, minified and pinned by
  `runtime-build/package-lock.json`.

The package comes from npmjs, so installing needs no token.

```bash
cd runtime-build
npm install
npm run build   # DEBUG=1 npm run build leaves the package unminified and adds source maps
```

neuro-san uses OpenAI's Responses API for OpenAI models by default, and the launcher's
mock router and BYOK proxy both speak it as well as chat completions. For a local model
that only speaks chat completions, set `"use_responses_api": false` in the network's
`llm_config`.

What comes from neuro-san: the config filter chain, `AgentNetwork`, the network
validators, `sly_data` redaction, external agent and MCP reference parsing, and the
whole loop, including sub-agents, MCP tools (`LangChainMcpAdapter`) and partner networks
(`ExternalActivation`). What stays nsdeploy's own, in
[`engine.js`](nsdeploy/runtime/ts-package/engine.js) and
[`composition.js`](nsdeploy/runtime/ts-package/composition.js): router selection and the BYOK
guarantee, consent before contacting a partner or an MCP server, per-query composition
limits, link slots, the trace the UI draws, and CRUSE widget extraction. neuro-san's loop
calls into those through hooks in
[`runtime-build/neuro-san-session.mjs`](runtime-build/neuro-san-session.mjs).

A partner network is still fetched and run in this browser: neuro-san asks the engine
for the partner's published network the first time an agent calls it, after consent, and
runs it as its own `AsyncDirectAgentSession` with the caller's router.

Two gaps in the package are worked around in `runtime-build/`, never by editing the
package, so a rebundled package stays reproducible from its transpiling source. Its
`urlparse` differs from Python's on some URLs, and it doesn't export `BaseToolFactory`.
Each is marked `WORKAROUND` / `PORT BACK` with what to fix upstream.

## Runtime UI

The served page is consumer-grade, not a raw
chatbot:

- **Clean answers.** neuro-san agents reply in the AAOSA wire format (a JSON envelope
  with `Mode`/`Inquiry`/`Response`/`Requirements`, sometimes wrapped in
  `<tool_response>` tags). The chat unwraps it at display time — showing the
  human-facing `Response` (or, for a `Determine` reply, the requirement prompt) —
  instead of leaking the raw protocol JSON. Inter-agent messages keep their structure.
- **Generative UI (CRUSE)** carries presentation proposals up the agent hierarchy.
  Each parent consolidates its children's suggestions; the final response can mix
  formatted text, reports, tables, charts, HTML and optional input widgets.
- **Live activity streaming** exposes typed, per-turn agent/tool lifecycle events,
  including coded-tool and MCP progress notifications, before the final answer is
  ready. Sibling tool calls run concurrently (bounded, with deterministic result
  ordering); tools can opt out with `parallel_safe = false`. The consumer UI reduces
  these events to one transient `.ns-turn-status` line inside the conversation and
  removes it when the final answer appears; the complete event log remains in Developer
  view. Theme designers can style the line, spinner, and text independently.
  Programmatic consumers can `for await` over `Engine.streamTurn(...)`; events include
  `turn.*`, `agent.*`, and `tool.*`, with downstream text deltas marked
  `visibility: "developer"` and the final result carried by `turn.completed`.
- **Live steering** keeps the input enabled during a running turn. A user can add
  guidance without starting a second turn; the top orchestrator interrupts an
  in-flight model response or consumes the update after active tool/downstream work
  finishes, then replans before producing its final answer. Already-started tools are
  not cancelled or replayed, which avoids duplicating side effects. Programmatic
  consumers call `stream.steer(text)` on the object returned by `Engine.streamTurn()`;
  accepted input produces `turn.steering.received` and `turn.steering.applied` events.
  Themes can style the active input state, update button, and steering message via
  `.ns-steering-active`, `.ns-send-steering`, and `.ns-steering-message`.
- **Resizable layout.** The chat and the right rail sit **side by side** with a
  **draggable splitter** between them (the rail width is remembered across reloads);
  each pane scrolls its own overflow and the app scrolls rather than crushing a pane
  into a sliver when space is tight.
- **Developer panel** (top-right toggle): an **agent graph** drawn as a hierarchy of
  boxes joined by edges — the front-man at the root, sub-agents nested beneath, and
  MCP/remote/coded tools as dashed leaf boxes; the active agent/origin **glows and its
  dot pulses** as a run progresses. Plus a live, exportable **execution log**.
- **BYOK / router settings** let the user pick a real model + key at run time and save
  named setups (for example, Local LLM, OpenAI, or an Anthropic-compatible router).
  Keys are never put in the URL; profiles are stored in the browser, with loopback
  localhost/127.0.0.1 deployments mirrored to a local cookie so the same setups
  prefill across nsDeploy ports and agent networks. The LLM badge stays unverified
  until a real response identifies its model. Cross-network/MCP call-outs are consent-gated.

## Example: `travel_agent_system.hocon`

The bundled example (`examples/travel_agent_system.hocon`) is a 10-agent AAOSA travel
concierge. Deploying it (tools pulled from `cognizant-ai-lab/neuro-san-studio@main`)
reports:

- ✅ 4 hostable tools → `ddgs_search`, `web_fetch`, `webpage_rag`,
  `wikimedia_media_search` — each hosted as an MCP server and callable for real;
- 🔌 1 external MCP (`api.you.com`) — kept and reached through a same-origin proxy
  (no browser CORS issue); in testing the remote returned HTTP 403 — i.e. *it* blocks
  anonymous clients, but nsdeploy does attempt the call and surfaces the result;
- ⚠️ 6 demo-mode (ungrounded) agents: intake, itinerary, flight search, accommodation
  search, budgeting, final response;
- ℹ️ 1 missing include (`config/llm_config.hocon` is fetched; the resolver still notes
  any include it can't find) — non-fatal (default model).

(Exact counts depend on the repo `--ref`; against an older checkout fewer tools
resolve. The point is the report tells you precisely what is grounded vs not.)

## Notes / limits

- The mock router is a deterministic, name-agnostic stand-in (it calls each
  advertised tool once, then summarizes); orchestration quality is only meaningful
  with a real LLM via BYOK. The mock exists so the site runs end-to-end with no key.
- Hosting a studio tool imports its `CodedTool` class (a lightweight neuro-san
  interface) — that's a build/host-time library import, **not** a neuro-san server.
- One MCP server per hostable tool preserves per-agent tool scoping. Private ports are
  assigned dynamically and exposed through stable same-origin proxy paths.
