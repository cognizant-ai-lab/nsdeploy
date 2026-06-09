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
`--upstream` (BYOK proxy upstream), `--runtime-dir` (override the vendored runtime).

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
5. **Generate** `index.html` + `agent-manifest.json` + `<network>.network.json`.
6. **Serve** one static origin (site + the `neuro-san-web` runtime, with the
   sandbox-worker CSP), a mock LLM router at `/v1`, a BYOK proxy at `/byok/v1`, and an
   external-MCP proxy at `/ext-mcp/<i>/mcp`, plus the local MCP server subprocesses.

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
