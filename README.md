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

The browser runs the agents on a **vendored copy of the neuro-san-web runtime** (in
[`runtime/`](runtime) — dependency-free ES modules); the only Python that runs is
(a) the build-time HOCON resolver and (b) one small MCP server per hostable tool.

## Install & run

```bash
pip install "mcp>=1.0.0" uvicorn starlette pyhocon neuro-san

# Tools are pulled from GitHub automatically — no --studio needed:
python -m nsdeploy examples/travel_agent_system.hocon --port 8080
```

Then open <http://127.0.0.1:8080/>. Flags: `--repo`/`--ref` (GitHub source, default
`cognizant-ai-lab/neuro-san-studio@main`), `--studio DIR` (use a local checkout
instead of GitHub), `--no-serve` (generate only), `--port`, `--out` (site dir),
`--site-dir` (editable HTML/CSS/JS source),
`--site-url` (public origin), `--link`/`--links` (outbound network bindings),
`--upstream` (BYOK proxy upstream), `--runtime-dir` (override the vendored runtime),
`--no-cruse` (skip generative-UI injection), and the theming flags below.

By default it runs on a deterministic **mock** LLM (no key needed). For real output,
open **⚙ BYOK settings** in the page and enter your API key + model — calls route
through the same-origin `/byok/v1` CORS proxy to your provider. A saved profile with
a real key is automatically moved off the site's mock `/v1` route. The header reports
a real LLM only after the endpoint returns a verifiable, non-mock model response;
routing errors are shown as errors rather than silently falling back to mock.

## Cailville multi-site demo

[`cailville/`](cailville) contains thirteen independently deployed household,
business, broker, and civic agent networks, their decentralized link sidecars, and
an interactive town map. Start the complete demo from the repository root:

```bash
./cailville/launch_all.sh
```

The launcher uses `venv/bin/python` when available, starts the sites on ports
8091-8103, waits for every site, and then opens `cailville/cailville.html`. Logs are
written to `.nsdeploy/cailville-logs/`. Its runtime BYOK proxy defaults to OpenAI and
theme generation defaults to `gpt-5.6`; override those with `NSDEPLOY_UPSTREAM`,
`NSDEPLOY_THEME_MODEL`, or `NSDEPLOY_PYTHON`. Existing editable themes are preserved;
set `NSDEPLOY_THEME_REFRESH=1` only when you deliberately want to replace them.

To run the agents with Docker Model Runner instead, explicitly select its upstream
and enter one of the exact IDs returned by its `/models` endpoint in BYOK settings:

```bash
NSDEPLOY_UPSTREAM=http://localhost:12434/engines/v1 ./cailville/launch_all.sh
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

## What it does (pipeline)

1. **Resolve** the HOCON with pyhocon, includes relative to the studio root, so
   `include "registries/aaosa.hocon"` and `${aaosa_call}`/`${demo_mode}` resolve
   exactly as neuro-san would resolve them.
2. **Classify & dependency-check** every entry in `tools`:
   - LLM agents (run in the browser),
   - `toolbox`/`class` tools resolved against the studio's `toolbox_info.hocon` +
     `coded_tools/` → **hostable** (can run as MCP) or **missing**,
   - MCP/remote URLs,
   - and it flags **`demo_mode`** agents, **missing includes**, and **external MCP
     URLs**.
3. **Host** each hostable tool as a standalone **FastMCP** streamable-HTTP server
   (with CORS), exposing its `CodedTool.invoke(args, sly_data)` as an MCP tool whose
   input schema is built from the tool's JSON-Schema parameters. The launcher picks
   an available private port for each process, avoiding collisions between sites.
4. **Rewrite** the resolved network (a copy): each hostable tool reference becomes its
   stable same-origin `/_mcp/<i>/mcp` URL; each **external MCP** URL becomes a proxy URL
   (`/ext-mcp/<i>/mcp`) so the browser can call it without CORS; missing tools and
   non-MCP external URLs are dropped. This removes any assumption of a local neuro-san
   server — tools are reached purely over MCP.
5. **Generate** `index.html` + `theme.css` + `site.js` + `agent-manifest.json` +
   `<network>.network.json` + `theme.json` from the editable site source and network.
6. **Serve** one static origin (site + the `neuro-san-web` runtime, with the
   sandbox-worker CSP), a mock LLM router at `/v1`, a BYOK proxy at `/byok/v1`, and an
   local-MCP proxy at `/_mcp/<i>/mcp`, an external-MCP proxy at
   `/ext-mcp/<i>/mcp`, plus the private local MCP server subprocesses.

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
or a HOCON `links` entry replaces it. Truly undefined references are still
supported as interactive link slots: when called, the browser asks for the target
site URL and stores the resulting outbound link. Without a local HOCON, a
hard-coded link, or an explicit peer URL, the linker cannot discover an unknown
site.

## Grounding & `demo_mode`

`nsdeploy` prints a dependency report at deploy time. Agents whose instructions use
`${demo_mode}` are listed under **"DEMO-MODE agents — NOT GROUNDED"**: they fabricate
realistic-looking answers instead of using real data/tools. **Ground them later** by
giving each a real tool/data source and removing `demo_mode` from its instructions.
Tools that can't be resolved from the repo (and non-MCP external URLs) are likewise
reported and dropped. **External MCP servers are kept** — proxied same-origin so the
browser can call them; whether a given call succeeds then depends on that remote
server (reachability/auth) and the user's run-time consent.

## Generative UI (CRUSE)

By default nsdeploy **injects a domain-agnostic CRUSE directive into every agent's
instructions** (in the generated copy — your source HOCON is untouched), so any
deployed network produces generative-UI widgets automatically: a **form** when an
agent needs input, a **choice** when it offers options, a **confirm** before
finalizing, an **info** card for summaries. The runtime extracts the fenced
` ```cruse-ui ` JSON each agent emits and renders it, consolidating widgets up the
agent chain. Opt out with `--no-cruse`.

Widgets are emitted by the **LLM** following the directive, so they appear only with
a real model (BYOK) — the deterministic mock router never emits them. Verified with a
local `qwen2.5:7b`: the agents emitted `form` and `choice` widgets unprompted.

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
overwrite them; `.nsdeploy/<network>/` remains disposable build output. A normal
`--theme` run also uses an existing package instead of calling the model again. The
LLM result is therefore a starting point: edit the source package and redeploy. The
generated `site.js` exports an optional `customize({ root, runtime })` hook, and any
files under `assets/` are copied into the built site.

Theme proposals are also cached under `~/.cache/nsdeploy/themes/`. `--theme-refresh`
is the explicit destructive refresh for `layout.html`, `theme.css`, and `theme.json`;
it preserves `site.js` and `assets/`, and it preserves the current design if the LLM
does not return a valid replacement. The theming key is supplied by *you* at deploy
time; end users still need no key. Flags: `--theme`, `--theme-model`,
`--theme-upstream`, `--theme-key`, `--theme-file`, `--theme-refresh`, `--site-dir`.

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

# Or wipe the cache entirely (all designs regenerate on the next run)
rm -rf ~/.cache/nsdeploy/themes/
```

The cache key is a hash of the **network identity + model name + prompt version**, so
a cached theme is reused only when all three match. Once source has been created,
changing the model does not replace user edits; use `--theme-refresh` when that is
really what you intend.

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

## Runtime UI

The served page (the vendored neuro-san-web runtime) is consumer-grade, not a raw
chatbot:

- **Clean answers.** neuro-san agents reply in the AAOSA wire format (a JSON envelope
  with `Mode`/`Inquiry`/`Response`/`Requirements`, sometimes wrapped in
  `<tool_response>` tags). The chat unwraps it at display time — showing the
  human-facing `Response` (or, for a `Determine` reply, the requirement prompt) —
  instead of leaking the raw protocol JSON. Inter-agent messages keep their structure.
- **Generative-UI widgets (CRUSE)** are extracted from each agent's reply and rendered
  as forms/choices/confirms/info cards, consolidated up the agent chain (see above).
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
