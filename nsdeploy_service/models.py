"""Request/response schemas for the deployment API."""
from __future__ import annotations

from enum import Enum
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

from pydantic import BaseModel
from pydantic import Field
from pydantic import field_validator

# themespec owns the one seam into nsdeploy's private colour rule, so the schema
# validates against exactly what the write path will accept (see themespec.py).
from nsdeploy_service.themespec import is_color


class DeploymentStatus(str, Enum):
    """Lifecycle of one deployed network.

    queued  — accepted, waiting for a build slot (builds fetch from GitHub and may
              pip-install tool deps, so they are throttled)
    building— nsdeploy is resolving/generating; the port is reserved but not listening
    ready   — the site answered HTTP 200 on its port; `url` is live
    failed  — the child exited, timed out, or never listened; see `error` + logs
    stopped — torn down by DELETE, TTL expiry, or service shutdown
    """

    QUEUED = "queued"
    BUILDING = "building"
    READY = "ready"
    FAILED = "failed"
    STOPPED = "stopped"


class DeployOptions(BaseModel):
    """Per-deployment overrides for the service-wide nsdeploy defaults."""

    name: Optional[str] = Field(
        default=None,
        description="network name; defaults to the uploaded filename stem. Becomes the "
                    "HOCON filename, so nsdeploy derives the network name from it.",
    )
    org_id: Optional[str] = Field(
        default=None,
        description="owning organization by id; must already exist. Takes precedence "
                    "over org_name. With neither, the deployment is attributed to the "
                    "seeded 'Unattributed' organization so the directory stays complete",
    )
    org_name: Optional[str] = Field(
        default=None,
        description="owning organization by name, created on first use and matched "
                    "case-insensitively afterwards. This is what the console sends: an "
                    "operator types their organization instead of having to create a "
                    "profile and then pick its id. Ignored when org_id is given.",
    )
    upstream: Optional[str] = Field(
        default=None,
        description="ignored. Every site's /byok/v1 forwards to the service-wide upstream "
                    "(NSDEPLOY_SERVICE_UPSTREAM). Kept so stored options still parse; an "
                    "upload that names a different upstream is refused with 400.",
    )
    theme: Optional[bool] = Field(
        default=None,
        description="run deploy-time LLM theming (needs OPENAI_API_KEY in the service "
                    "environment; adds minutes to the build)",
    )
    theme_model: Optional[str] = Field(default=None, description="model used when theme is on")
    theme_refresh: Optional[bool] = Field(
        default=None,
        description="re-ask the LLM and replace an existing theme rather than reusing "
                    "one already on disk; meaningless unless theme is also on",
    )
    theme_prompt: Optional[str] = Field(
        default=None, max_length=4000,
        description="extra design instructions folded into the deploy-time theming "
                    "prompt (nsdeploy's own --theme-prompt); meaningless unless theme "
                    "is also on",
    )
    cruse: Optional[bool] = Field(
        default=None, description="inject the CRUSE generative-UI directive into agents",
    )
    ttl_seconds: Optional[int] = Field(
        default=None, ge=0, description="override the service TTL; 0 means never expire",
    )


class BundleOptions(BaseModel):
    """Per-request overrides for one static bundle build.

    Deliberately not DeployOptions. A bundle has no organization, no TTL and no
    place on the map, because nothing about it is kept: it is built, handed over and
    forgotten. The fields it does share are the ones that change what nsdeploy
    generates.
    """

    name: Optional[str] = Field(
        default=None,
        description="network name; defaults to the uploaded filename stem. Becomes the "
                    "HOCON filename, so nsdeploy derives the network name from it, and "
                    "names the returned archive.",
    )
    site_url: Optional[str] = Field(
        default=None,
        description="the origin the client will host this bundle on. Baked into the "
                    "manifest, the .well-known document and the generated steward "
                    "HOCON, so it cannot be changed after the build. Omit it for a "
                    "bundle addressed relative to wherever it is served, which works "
                    "only at a domain root.",
    )
    upstream: Optional[str] = Field(
        default=None,
        description="the LLM endpoint the generated page calls with the reader's own "
                    "key. A static bundle has no server to proxy it, so this is "
                    "called straight from the browser and must allow CORS.",
    )
    theme: bool = Field(
        default=False,
        description="run LLM theming for this bundle. Off unless asked for, even when "
                    "the service-wide THEME setting is on: theming adds 30-90 seconds "
                    "to a request which answers on the open connection. Needs "
                    "OPENAI_API_KEY in the service environment; without one the "
                    "default look is used and a warning is reported.",
    )
    theme_model: Optional[str] = Field(
        default=None, description="model used when theme is on",
    )
    theme_refresh: bool = Field(
        default=False,
        description="re-ask the model rather than reusing a cached answer for this "
                    "network; meaningless unless theme is also on",
    )
    theme_prompt: Optional[str] = Field(
        default=None, max_length=4000,
        description="extra design instructions folded into the theming prompt; "
                    "meaningless unless theme is also on",
    )
    cruse: Optional[bool] = Field(
        default=None,
        description="inject the CRUSE generative-UI directive into agents; defaults to "
                    "the service-wide setting",
    )


# ── organization names ───────────────────────────────────────────────────────
# Defined here rather than in app.py because three places need the same rule and the
# first version of this lived in only one of them: the two upload endpoints were
# bounded while POST /orgs, PATCH /orgs and the console's own "change organization"
# dialog were not, so a long name was refused on upload and accepted everywhere else.
# models.py is the lowest layer that all of them already import.
ORG_NAME_MAX = 40

# Letters and digits are Unicode (\w), so "Zürich Analytics" and non-Latin team names
# are accepted — this is an international event and an ASCII-only rule would reject
# real names. Alongside them, only the punctuation that genuinely appears in company
# and team names: & ' ( ) . , - / + # and the space.
#
# First and last character must be a word character (or a closing bracket or full stop
# at the end), which refuses leading and trailing whitespace, names that are nothing
# but punctuation, and the "-Max" shape.
#
# Refused: angle brackets, quotes, backticks, semicolons, pipes, tabs and newlines.
# Output is escaped everywhere it is rendered, so this is not what stands between the
# service and an injection — it is what keeps a name a name, so it cannot carry a URL,
# a pasted command or a line break into the directory, the filter and the map.
#
# Length is a separate job: a 30-character hex string is made entirely of legal
# characters, so only ORG_NAME_MAX refuses a pasted credential.
ORG_NAME_PATTERN = r"^[^\W_](?:[\w &'().,\-/+#]*(?:[^\W_]|[).]))?$"


class OrgCreate(BaseModel):
    """A 'quick profile' for the team that owns an agent network.

    This is attribution metadata, not a credential: the service has a single shared
    API token, so anyone who can reach it can act on any organization's deployments.
    """

    name: str = Field(min_length=1, max_length=ORG_NAME_MAX, pattern=ORG_NAME_PATTERN,
                      description="organization name (unique)")
    address: str = Field(default="", max_length=500)
    contact: str = Field(default="", max_length=200, description="email, team channel, or owner")


class OrgUpdate(BaseModel):
    """
    Partial update to an organization; omitted fields stay unchanged.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=ORG_NAME_MAX,
                                pattern=ORG_NAME_PATTERN)
    address: Optional[str] = Field(default=None, max_length=500)
    contact: Optional[str] = Field(default=None, max_length=200)


class OrgView(BaseModel):
    """
    An organization as returned by the API, with its deployment counts.
    """

    id: str
    name: str
    address: str = ""
    contact: str = ""
    created_at: str
    deployment_count: int = 0
    live_count: int = Field(default=0, description="deployments currently queued, building, or ready")


class OrgList(BaseModel):
    """
    List of organizations.
    """

    organizations: List[OrgView]


class NetworkLink(BaseModel):
    """A resolved outbound agent-network link — one real edge on the map.

    Read from the generated bundle's `linking.imports` where `status == "linked"`.
    A `pending` import is a dangling reference, reported via `link_slots` instead.
    """

    reference: str = Field(description="the agent reference this link satisfies")
    target: str = Field(description="absolute URL of the linked remote network")
    callers: List[str] = Field(default_factory=list,
                               description="agents in this network that call it")


# Bump this whenever a field is added to NetworkSummary that _repair_summaries()
# should backfill onto records built before it existed. A stored summary carrying
# an older version is re-derived from the bundle once, at the next startup.
SUMMARY_SCHEMA_VERSION = 1


class NetworkSummary(BaseModel):
    """Structured build result, read back from the generated bundle."""

    schema_version: int = Field(
        default=SUMMARY_SCHEMA_VERSION,
        description="which revision of this model the summary was derived under. It "
                    "is what tells _repair_summaries() that a record has been "
                    "derived at all, which no individual field can: a field that is "
                    "legitimately empty — a front-man with no description, a network "
                    "with no links — is indistinguishable from one that was never "
                    "filled in, so a completeness check written over the fields "
                    "themselves re-derives such a record on every single startup and "
                    "never converges. Records written before this field existed read "
                    "back as 0 and are backfilled once.",
    )
    front_man: str = ""
    agent_count: int = 0
    hostable_tools: List[str] = Field(default_factory=list)
    external_mcps: List[str] = Field(default_factory=list)
    missing_tools: List[str] = Field(default_factory=list)
    demo_mode_agents: List[str] = Field(default_factory=list)
    link_slots: List[str] = Field(default_factory=list)
    links: List[NetworkLink] = Field(
        default_factory=list,
        description="resolved outbound links to other agent networks",
    )
    peer_urls: List[NetworkLink] = Field(
        default_factory=list,
        description="agent-network URLs written straight into an agent's `tools`, "
                    "rather than bound through a named link slot. nsdeploy keeps "
                    "these verbatim in the generated config and reports them as "
                    "`external_networks` rather than as `linking.imports`, so they "
                    "are collected separately — but they are outbound calls to "
                    "another network just the same, and the map draws them.",
    )
    brand: str = ""
    description: str = ""
    front_man_description: str = Field(
        default="",
        description="the front-man agent's own `function.description` — what the "
                    "network actually does, in the author's words. Kept alongside "
                    "`description` rather than replacing it because the two diverge "
                    "under deploy-time theming: the LLM rewrites the network-level "
                    "`description` into a brand tagline (\"Prep, staff, sell, "
                    "recover.\") and leaves the agent's authored purpose untouched, "
                    "so after theming this is the only field that still says what "
                    "the network is for. The console's connect prompt uses it, "
                    "because a tagline tells an agent-network designer nothing about "
                    "what a down-chain agent does. Empty on records built before this "
                    "was recorded; _repair_summaries() backfills those at startup.",
    )
    sample_queries: List[str] = Field(default_factory=list)


class DeploymentView(BaseModel):
    """Everything the caller can see about one deployment."""

    id: str
    name: str
    org_id: str = ""
    org_name: str = ""
    status: DeploymentStatus
    url: Optional[str] = Field(default=None, description="live site URL; set once status is ready")
    port: Optional[int] = None
    created_at: str
    ready_at: Optional[str] = None
    stopped_at: Optional[str] = None
    expires_at: Optional[str] = None
    error: Optional[str] = None
    pid: Optional[int] = None
    replaced: bool = Field(
        default=False,
        description="this upload replaced an existing network of the same name in "
                    "the same organization, reusing its id, port, URL and map "
                    "position. Describes the one request that returned it, so it is "
                    "only ever true on a deploy response — never on a later read.")
    published: bool = Field(
        default=False,
        description="whether this network appears on the map. True from creation while "
                    "the AUTOPUBLISH setting is on (the default), so a launch is visible "
                    "immediately; with it off a deployment starts as a draft — live and "
                    "testable at its own URL, but off the map until "
                    "POST /deployments/{id}/publish. Withdraw with /unpublish either way",
    )
    published_at: Optional[str] = None
    publishable: bool = Field(
        default=False,
        description="whether POST /publish would succeed right now: ready and not "
                    "already published. Derived server-side so a client does not "
                    "re-implement the rule",
    )
    publish_blocked_reason: Optional[str] = Field(
        default=None,
        description="why publishing is unavailable, phrased as the action to take "
                    "(deploy it / restart it). Null when it is publishable or "
                    "already published",
    )
    endpoints: Dict[str, str] = Field(
        default_factory=dict,
        description="notable routes on the deployed origin (site, mock LLM, BYOK proxy, MCP facade)",
    )
    network: Optional[NetworkSummary] = None
    warnings: List[str] = Field(default_factory=list)
    # This deployment's own theme override, as stored on its DeployOptions — null
    # means "falls back to the service-wide default", same convention as the field
    # it mirrors. Surfaced so the network list can show and edit what is actually
    # in effect for this one deployment, not the service-wide default.
    theme: Optional[bool] = None
    theme_refresh: Optional[bool] = None
    theme_prompt: Optional[str] = None


class DeploymentList(BaseModel):
    """
    List of deployments plus the port-pool capacity.
    """

    deployments: List[DeploymentView]
    capacity: Dict[str, Any]


class ThemeUpdate(BaseModel):
    """Body for POST /deployments/{id}/theme.

    Every field is optional so an edit touching only the prompt does not have to
    resend the others; `None` means "leave this deployment's existing override
    alone", not "clear it" — there is no way to clear an override back to the
    service default through this endpoint today.
    """

    theme: Optional[bool] = None
    theme_refresh: Optional[bool] = None
    theme_prompt: Optional[str] = Field(default=None, max_length=4000)


class ThemeTokens(BaseModel):
    """The directly editable part of a site's look — nsdeploy's ThemeSpec minus
    the model's business.

    Body for POST /deployments/{id}/theme-spec and the `current`/`defaults`
    blocks of the GET. Every field is optional; `None` means "leave this one as
    it is". Bounds here are the API's promise to the caller — the authoritative
    validation is ThemeSpec.coerce's, which clamps and falls back rather than
    refusing, so a value that survives this model still gets normalized (a font
    stack gains a generic family, an unparseable colour reverts).

    `welcome` and the creative layout (`body`/`style`) are absent on purpose:
    those are the deploy-time model's output, carried through an edit untouched.
    """

    brand: Optional[str] = Field(default=None, max_length=60,
                                 description="header wordmark; empty means the build derives one")
    icon: Optional[str] = Field(default=None, max_length=8, description="one emoji, shown before the brand")
    tagline: Optional[str] = Field(default=None, max_length=120, description="subtitle under the brand")
    hero: Optional[str] = Field(default=None, max_length=280,
                                description="one-line greeting, used only when this site has a welcome form")
    font: Optional[str] = Field(default=None, max_length=120, description="CSS font stack")
    radius: Optional[int] = Field(default=None, ge=0, le=28, description="corner radius in px")
    colors: Optional[Dict[str, str]] = Field(
        default=None,
        description="any subset of primary, accent, bg, bg_tint, fg, muted, border, "
                    "msgbg, panelbg; #hex, rgb()/hsl(), or a CSS keyword. Unknown "
                    "keys are ignored",
    )

    @field_validator("colors")
    @classmethod
    def _check_colors(cls, value: Optional[Dict[str, str]]) -> Optional[Dict[str, str]]:
        """Refuse a colour the theme layer cannot parse, rather than accept it.

        Writing it would be worse than refusing: ThemeSpec.coerce fails open to
        the *default* colour, so a typo'd hue would come back as stock blue and
        read as "the edit was applied, just not the way I meant".
        """
        for key, colour in (value or {}).items():
            if not is_color(colour):
                raise ValueError(
                    f"{key}: {colour!r} is not a colour — use #hex, rgb()/hsl(), "
                    "or a CSS keyword",
                )
        return value


class ThemeSpecView(BaseModel):
    """What GET /deployments/{id}/theme-spec answers."""

    current: ThemeTokens
    defaults: ThemeTokens
    source: str = Field(description="where `current` was read from: site-source, built, or default")
    has_custom_layout: bool = Field(
        description="whether a model-authored layout is in place. Editing tokens keeps it, "
                    "but a generic preview will not show it",
    )
    built: bool = Field(description="whether a built bundle exists to restyle without rebuilding")
    live: bool = Field(description="whether the site is running, so an edit shows on the next page load")


class ThemeSpecApplied(BaseModel):
    """What POST /deployments/{id}/theme-spec answers.

    No relaunch happens, so there is no DeploymentView to return — the record did
    not change, only the files it points at.
    """

    current: ThemeTokens
    applied_live: bool = Field(
        description="true when the built bundle was restyled, so a running site serves the "
                    "new look on the next page load. False when nothing is built yet and the "
                    "change waits for the first build",
    )


class DirectoryOrg(BaseModel):
    """One organization and the agent networks it has deployed."""

    organization: OrgView
    deployments: List[DeploymentView]


class DirectoryView(BaseModel):
    """The shared, cross-organization catalogue of deployed agent networks."""

    organizations: List[DirectoryOrg]
    totals: Dict[str, Any]


class GraphNode(BaseModel):
    """One deployed network as a pin on the map."""

    id: str
    name: str
    org_id: str
    org_name: str
    status: DeploymentStatus
    url: Optional[str] = None
    x: float = Field(description="horizontal position, percent of the map viewport")
    y: float = Field(description="vertical position, percent of the map viewport")
    front_man: str = ""
    agent_count: int = 0
    description: str = ""
    hosted_tools: int = 0
    open_slots: int = Field(default=0, description="unlinked agent-network references")
    external_links: int = Field(
        default=0, description="resolved links pointing outside this service")
    warnings: int = 0


class GraphEdge(BaseModel):
    """A resolved agent-network link between two nodes on this map."""

    source: str = Field(description="deployment id that calls")
    target: str = Field(description="deployment id that is called")
    reference: str = Field(description="the agent reference the link satisfies")
    callers: List[str] = Field(default_factory=list)


class SuggestedEdge(BaseModel):
    """A relation *inferred* from the two networks' descriptions — not a real link.

    Deliberately a separate type from `GraphEdge`. A GraphEdge exists because somebody
    bound one network to another; this is a suggestion derived from text, so it carries
    its evidence and must be rendered distinctly. Nothing in the service turns one into
    a binding: an inferred delegation written to a site's links.json would be served to
    every visitor as though a human had chosen it.
    """

    source: str = Field(description="deployment id that would call")
    target: str = Field(description="deployment id that would be called")
    kind: str = Field(
        description="capability (an unfilled reference matches what the target does) | "
                    "affinity (the two describe similar subject matter) | model")
    score: float = Field(description="strength of the evidence; capability always outranks affinity")
    reason: str = Field(description="why this was suggested, in words, for display")
    reference: Optional[str] = Field(
        default=None, description="the unfilled reference, for a capability relation")
    origin: str = Field(default="heuristic", description="heuristic | llm")


class RelationsView(BaseModel):
    """Inferred relations across the deployed networks."""

    edges: List[SuggestedEdge]
    strategy: str = Field(description="which producer ran: heuristic | llm")
    networks: int = Field(description="networks considered")
    generated_at: str


class GraphView(BaseModel):
    """Read-only projection of the registry as a network map.

    Nodes come from the deployment records; `edges` only from links that genuinely
    resolved, and `suggested_edges` only from inference over descriptions. The two are
    kept apart so the map can never show a guess as though it were a wired connection.
    Nothing here alters a deployment.
    """

    nodes: List[GraphNode]
    edges: List[GraphEdge]
    suggested_edges: List[SuggestedEdge] = Field(
        default_factory=list,
        description="relations inferred from descriptions; advisory, never applied")
    organizations: List[OrgView]
    refresh_seconds: int = Field(
        description="server-recommended poll interval; the UI may override it")
    totals: Dict[str, Any]
    generated_at: str


class AgentGraphNode(BaseModel):
    """One agent, tool, or hosted/external endpoint inside a single deployed network."""

    id: str
    name: str
    kind: str = Field(description="root (front-man) | orchestrator | agent | external")
    description: str = Field(
        default="",
        description="what this agent is for, as its HOCON author wrote it — the "
                    "resolved `function.description`, whitespace normalized. The "
                    "endpoint URL for an external node. Empty when the HOCON "
                    "declared none",
    )
    calls: List[str] = Field(
        default_factory=list,
        description="names of the agents this one delegates to, in declaration "
                    "order. The same relationships as `edges`, kept per-node so a "
                    "reader can see one agent's reach without walking the edge list",
    )


class AgentGraphEdge(BaseModel):
    """A delegation: `source` calls `target` as one of its tools."""

    source: str
    target: str


class AgentGraphView(BaseModel):
    """The internal agent topology of one deployed network — not the cross-network
    map (see `GraphView`), but what is inside a single HOCON: its agents, the tools
    they can call, and any hosted/external endpoints they reach."""

    id: str
    name: str
    front_man: str = ""
    nodes: List[AgentGraphNode]
    edges: List[AgentGraphEdge]


class LogView(BaseModel):
    """
    Tail of a deployment's build or run log.
    """

    id: str
    status: DeploymentStatus
    lines: List[str]
    truncated: bool


class HealthView(BaseModel):
    """
    Service health and version information.
    """

    status: str
    version: str
    build: str = Field(
        default="",
        description="the image build this service runs (NSDEPLOY_SERVICE_BUILD_VERSION, "
                    "set at image build time); falls back to `version`.",
    )
    ui_version: str = Field(
        default="",
        description="the `?v=N` the served console pins its assets to. A console "
                    "compares this with the version it booted with and offers a "
                    "reload when they differ — a tab left open across an update "
                    "keeps running its old JavaScript, which is indistinguishable "
                    "from a broken UI. Empty means 'cannot tell', and is not a "
                    "mismatch.",
    )
    python: str
    platform: str
    deployments: Dict[str, int]
    port_pool: Dict[str, Any]
    build_queue: Dict[str, Any] = Field(
        default_factory=dict,
        description="Live build capacity. `slots` is MAX_CONCURRENT_BUILDS and "
                    "`slots_in_use` is how many are held right now; that pair, not "
                    "`building`, is what says whether the service is saturated. "
                    "`building` counts deployments in the `building` status, which "
                    "includes any that have generated their bundle and released "
                    "their slot while they wait for their site to answer — so "
                    "`building` can exceed `slots_in_use`. `waiting` is how many sit "
                    "in `queued`, and `oldest_wait_seconds` is the longest any of "
                    "them has waited, or null when none does. Nothing times a "
                    "deployment out while it waits for a slot, so `slots_in_use` at "
                    "`slots` with a rising `oldest_wait_seconds` is a stalled queue "
                    "rather than a busy one.",
    )
    reconciled_at_startup: int = Field(
        default=0,
        description="deployment records this run settled to `stopped` at boot because "
                    "their processes did not survive a restart. A startup statistic, "
                    "not a fault — deliberately not a warning, since a one-off event "
                    "in `warnings` would be re-reported by every poll.",
    )
    warnings: List[str] = Field(
        default_factory=list,
        description="ongoing conditions an operator should act on. Each is expected to "
                    "persist until the underlying condition is fixed, so clients should "
                    "surface a given message once rather than on every poll.",
    )


class SettingsField(BaseModel):
    """One masked credential. The value itself never reaches the client — only
    whether it is set, and its last 4 characters, enough to recognize it without
    revealing it."""

    is_set: bool = False
    last4: str = ""
    # True when the admin panel holds a default for this credential. Both surfaces
    # can set these two, but only one of them wins after a restart: the panel
    # re-applies its own defaults on every boot (adminPanel/effects.py), so a value
    # saved here would be replaced. Reported rather than silently overridden,
    # because a save that quietly stops applying tomorrow is the worst outcome.
    managed_by_admin_panel: bool = False


class SettingsView(BaseModel):
    """
    Service settings as shown to the console, with secrets masked.
    """

    nsdeploy_api_token: SettingsField = Field(default_factory=SettingsField)
    openai_api_key: SettingsField = Field(default_factory=SettingsField)
    # Not secrets, so shown to the console verbatim rather than masked — these are
    # the same service-wide deploy defaults as Settings.upstream/theme/theme_model
    # (config.py), editable here instead of only via environment variables.
    upstream: str = ""
    theme: bool = False
    theme_model: str = ""
    theme_refresh: bool = False
    theme_prompt: str = ""


class SettingsUpdate(BaseModel):
    """Every field is optional so a save touching only one thing does not have to
    resend the rest. For the two credentials, a field left out (or sent empty)
    leaves that secret exactly as it was — the console never has the real value to
    send back for an untouched field, only the masked display string. The deploy
    defaults below carry no such secret, so the console always sends its current
    value for those; `None` there just means "this build of the console didn't send
    it", not "leave unchanged"."""

    nsdeploy_api_token: Optional[str] = Field(default=None, min_length=1, max_length=500)
    openai_api_key: Optional[str] = Field(default=None, min_length=1, max_length=500)
    upstream: Optional[str] = Field(default=None, max_length=500)
    theme: Optional[bool] = None
    theme_model: Optional[str] = Field(default=None, max_length=200)
    theme_refresh: Optional[bool] = None
    theme_prompt: Optional[str] = Field(default=None, max_length=4000)
