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
`--site-url` (public origin), `--link`/`--links` (outbound network bindings),
`--upstream` (BYOK proxy upstream), `--runtime-dir` (override the vendored runtime),
`--no-cruse` (skip generative-UI injection), and the theming flags below.

By default it runs on a deterministic **mock** LLM (no key needed). For real output,
open **⚙ BYOK settings** in the page and enter your API key + model — calls route
through the same-origin `/byok/v1` CORS proxy to your provider.

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
   input schema is built from the tool's JSON-Schema parameters.
4. **Rewrite** the resolved network (a copy): each hostable tool reference becomes its
   local MCP URL; each **external MCP** URL becomes a same-origin proxy URL
   (`/ext-mcp/<i>/mcp`) so the browser can call it without CORS; missing tools and
   non-MCP external URLs are dropped. This removes any assumption of a local neuro-san
   server — tools are reached purely over MCP.
5. **Generate** `index.html` + `agent-manifest.json` + `<network>.network.json`
   (+ `theme.json` when theming is used — see "Look & feel").
6. **Serve** one static origin (site + the `neuro-san-web` runtime, with the
   sandbox-worker CSP), a mock LLM router at `/v1`, a BYOK proxy at `/byok/v1`, and an
   external-MCP proxy at `/ext-mcp/<i>/mcp`, plus the local MCP server subprocesses.

## Linking separately deployed agent networks

Undefined agent names are retained as link slots. They can be bound to another
nsDeploy site ahead of deployment or when the model first calls the dangling tool.
Every site publishes `/.well-known/nsdeploy.json`; every binding is stored by the
calling site only. There is no registry, discovery service, or required deployment
order.

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
  --link airline_reservations=http://127.0.0.1:8092/link_demo_airline
```

For a non-local deployment, pass `--site-url https://public.example.com` so the
published manifest contains the externally reachable origin. Links may also be
hard-coded under a top-level HOCON
`links { reference = "https://site.example/network" }` block.

If a dangling tool is called without a binding, the browser asks the developer for
the target site's URL, validates its published manifest, and saves the outbound
link. The demo server persists it in its generated `links.json`; static hosts fall
back to browser-local storage. Without a local HOCON, a hard-coded link, or an
explicit peer URL, the linker cannot discover an unknown site.

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
OPENAI_API_KEY=sk-…  python -m nsdeploy net.hocon --theme [--theme-model gpt-4o-mini]

# LLM-polished with a LOCAL model (Ollama) — does NOT touch the runtime
python -m nsdeploy net.hocon --theme --theme-model qwen2.5:7b --theme-key x \
    --theme-upstream http://127.0.0.1:11434/v1

# pin a theme (no LLM, no key, reproducible) — edit it by hand or reuse a prior run
python -m nsdeploy net.hocon --theme-file theme.json
```

Theming is a **deploy-time** step. It uses `--theme-upstream` (which defaults to
OpenAI) + the deploy-time key (`$OPENAI_API_KEY` / `--theme-key`). Runtime
`--upstream` is independent and only controls the deployed app's BYOK proxy. Set
`--theme-upstream` explicitly when you want theming on a different provider — e.g.
theme with a local Ollama (`--theme-upstream http://127.0.0.1:11434/v1`) while the
deployed app still calls Docker Model Runner or OpenAI-compatible BYOK at runtime.

The LLM authors the page's **CSS + HTML around the assistant**, but it's treated as
untrusted and **strictly sanitized**: only safe presentational tags/attributes survive
(no `<script>`, `on*` handlers, `<iframe>`/`<form>`/`<svg>`; CSS stripped of `@import`,
`expression()`, unsafe `url()`). nsdeploy injects the `boot()` script and the `#app`
mount itself (the LLM never writes them), forces `#app` to stay **empty and a usable
size** (so the chat is never squeezed into a sliver), and on any problem (no key,
error, invalid/unsafe output, missing `#app`) **falls back to the default template** —
so a creative layout can never break the app or the keyless experience. The full
design is written to **`theme.json`** (inspectable, editable, re-usable via
`--theme-file`) and cached under `~/.cache/nsdeploy/themes/` (`--theme-refresh` to
re-ask). The theming key is supplied by *you* at deploy time; end users still need no
key. Flags: `--theme`, `--theme-model`, `--theme-upstream`, `--theme-key`,
`--theme-file`, `--theme-refresh`.

> Layout richness scales with the model: `gpt-4o`/`gpt-4o-mini` produce far more
> distinctive designs than a small local model like `qwen2.5:7b`. Whatever the model
> emits, the assistant stays usable and the build is safe.

### Regenerating the theme (clearing the cache)

Generated themes are cached under `~/.cache/nsdeploy/themes/` (one `<digest>.json`
per design) so re-running a deploy doesn't re-ask the LLM. To force a fresh design:

```bash
# Re-ask the LLM for THIS network/model/prompt, ignoring (and overwriting) the cache
python -m nsdeploy net.hocon --theme … --theme-refresh

# Or wipe the cache entirely (all designs regenerate on the next run)
rm -rf ~/.cache/nsdeploy/themes/
```

The cache key is a hash of the **network identity + model name + prompt version**, so
a cached theme is reused only when all three match. Switching `--theme-model` (e.g. to
a bigger model) regenerates automatically — no flag needed; `--theme-refresh` is only
needed when you want a new take from the *same* model and prompt.

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
  prefill across nsDeploy ports and agent networks. Cross-network/MCP call-outs are
  consent-gated.

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
- One MCP server per hostable tool (separate port) preserves per-agent tool scoping.
