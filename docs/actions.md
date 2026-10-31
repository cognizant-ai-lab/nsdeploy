# Browser action adapters and CRUSE bindings

## Build-time discovery of public websites

`--action-site URL` optionally discovers stateless native forms and linked JSON
OpenAPI 3 specifications while building. `--action-spec FILE_OR_URL` supplies an
explicit specification when one is not linked. Discovery does not execute page
JavaScript or business operations. It writes a reviewable
`<site-dir>/discovered-actions.json` lock; select operations with `enabled: true`
or `--action-allow NAME`. `--action-include-all` selects all supported candidates
for test sites. Refresh with `--action-refresh --action-site URL` and the original
`--action-spec`, if used. Otherwise builds reuse the lock without crawling again.

The runtime reads that data on the publishing origin and registers a generic HTTP
executor. The existing catalog, CRUSE bindings, confirmation and bridge protocol
apply unchanged. Agent output cannot change the fixed destination or HTTP method.
External requests omit credentials, reject redirects, validate arguments and
return bounded response evidence. Source forms are refreshed and their pinned
definition and HTML validity checked before submitting. Hidden state, credentials,
uploads and JavaScript handlers require another integration method.

External form pages and APIs must already permit CORS from the agent origin.
OPTIONS checks in the lock are advisory, never proof of successful execution.
The agent-site bridge does not bypass another website's origin restrictions.
The action runtime includes request-ID and SHA-256 fallbacks for plain-HTTP static
demos where `crypto.randomUUID()` and `crypto.subtle` are unavailable. HTTPS is
still required to protect a browser-local BYOK key and the JavaScript receiving it.
See [the README](../README.md#discover-a-public-site-while-bundling) for supported
schema subsets, build commands, and isolated/interconnected test instructions.

## Automatic native form discovery

There is no guessed action page. `--site-url` names the agent bundle, which usually
has no business forms. Use `--action-page /booking` for an existing application
route; repeat it for additional pages. `--action-host-page` opts into local live
document discovery when embedding the widget. `--no-action-discovery` cannot be
combined with either form flag; it does not disable explicitly registered modules.
The page must already exist on the origin hosting the bundle. Repeat the flag for
additional pages; paths are origin-relative, even when the bundle is at `/agents/`.
No adapter or HOCON extension is required. This discovery happens at runtime using the
user's session, never at build time, and is read-only. Do not point it at GET URLs
that perform mutations. The runtime fetches HTML without executing its scripts.

The registry generates a stable action for each form/submit-button combination,
with a schema for its named editable controls. Native form action/method/encoding,
submitter overrides and named submit buttons are respected. Hidden and readonly
fields remain on the owning origin and are reloaded before execution. The browser
validates pattern, step, date bounds and other native constraints beyond those
expressible in CRUSE. The runtime uses the browser's `FormData` construction for
successful controls, then submits using `fetch` with same-origin credentials.
See the [HTML form submission standard](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#constructing-the-entry-list).

All discovered forms default to `effect: "write"`, including GET forms. A site
owner can opt into read semantics with `data-nsdeploy-effect="read"`. Exclude a
form with `data-nsdeploy-ignore`. Remote access defaults to denied; add repeatable
`--action-caller-origin https://caller.example` flags for exact caller origins.
The same static bridge, origin checks, argument validation and confirmation flow
used by explicit adapters apply to discovered forms. Do not copy the target site's
forms to the caller; deploy the bridge beside the actual application.

Discovery diagnostics appear below the chat and in the browser console. The
`action_catalog` trace event reports local count and discovery issues. If no
capabilities are registered, agents are explicitly told to report the integration
gap instead of claiming to have checked data. Builds without any action source
also print that no browser actions are configured.
Explicitly targeting an empty generated agent page produces a build warning.
Other configured routes are verified only at runtime in the user's browser;
builds do not claim the application has been validated. Empty remote catalogs
report missing sources or caller authorization rather than implying connectivity.

### Forms beside an embedded widget

Build with `--action-host-page`, import the bundle's `runtime/index.js` in the
existing application page and call `boot("#agent-widget", { originUrl:
location.origin + "/agents/concierge", sandboxWorkerUrl:
"/agents/concierge/runtime/sandbox-worker.js" })`. Use a dedicated empty mount;
the mount and its descendants are excluded from discovery. Forms under
`data-nsdeploy-ignore` are also excluded.

Native forms already in the visible document, including forms rendered by the
application's JavaScript, are discovered. A DOM observer refreshes the catalog
when forms are added, changed or removed. When changing properties without DOM
mutations, call the returned `actions.refreshHostForms()` before asking for a new
proposal. Changed contracts invalidate old references. Execution rechecks the live
form, copies current fields/tokens into a detached document, and submits without
altering the user's draft or invoking JavaScript event handlers. This mode is for
native endpoints that work without submit listeners; JS-only forms still need a
registered action. Hidden/readonly values are never put in the public schema.

Host-page actions are always local-only: the remote bridge has a separate document
and cannot access the widget's live application state. Use explicit same-origin
route discovery or a bridge-compatible module to expose those capabilities
remotely. Host discovery is disabled inside the bridge itself.

Supported: server-rendered forms with an explicit same-origin action, GET/POST,
URL-encoded or multipart encoding, ordinary text/date/number controls, radio and
checkbox groups, selects, and multiple submit buttons. Public schemas omit current
field values to avoid leaking saved personal information. Optional fields omitted
from a proposal are cleared, rather than silently submitting saved values.

Limits:

- Client-rendered forms on fetched routes, JS event handlers, custom controls, uploads, passwords,
  payment fields and authentication UI need the site's own UI or an adapter.
  Inline handlers are detected and skipped. Listeners attached by scripts cannot
  be inferred from HTML: choose pages whose native form endpoint is functional
  without those scripts. No existing page JavaScript runs in the fetched document.
- Redirects are rejected, including login and post/redirect/get flows. A POST may
  have committed before a redirect is encountered; the outcome is then unknown.
  Use a registered adapter for such flows. This avoids following a redirect that
  could forward form data to an unreviewed destination.
- Discovery reads HTML pages up to 1 MB. Response evidence is capped at 12,000
  characters, excludes form/script content, redacts known hidden values and
  sensitive JSON keys. Review your responses before exposing them to callers:
  automatic filtering cannot identify every application-specific secret.
- Form identity, endpoint, method, schema and fixed fields are checked again before
  submission. Structural changes require refreshing the agent page; hidden fields
  with token/CSRF names may rotate, while other hidden values stay pinned to avoid
  changing the target record. Large/dynamic catalogs should use an explicit adapter.
- Generic native forms do not add server idempotency guarantees. Repeated clicks
  are suppressed within the session; reloads/new proposals may repeat operations.

Successful HTTP handling returns `outcome: "response_received"`,
`businessOutcome: "unverified"`, `httpStatus`, and `evidence: {format, text}`.
The enclosing action's `status: "succeeded"` means its handler returned a response,
not that the business accepted the request. Read the evidence and independently
verify reservation/order records. Error statuses, redirects, network failures and
timeouts produce `unknown`; never automatically retry a possibly committed write.

## Existing JavaScript modules

`--action-module /js/site-actions.js` loads an existing same-origin ES module
exporting `registerActions(actions)`. The file is not copied; it must already be
hosted there. Registration uses the API below, including its own `callerOrigins`.
Multiple modules, form pages and a copied `--actions` adapter can coexist (action
names must be unique). No arbitrary globals/functions are scanned or executed.
This export is the standard registration interface for existing JavaScript actions;
wrap an existing exported business function in `execute` and provide its schema
and caller policy. The function must work in a fresh bridge document if exposed
remotely; functions tied to live UI state must remain `local-only`. Registration
describes capabilities; it must not execute the business operation.

## Hosting and CORS

The static action bridge runs on the agent bundle's origin. For `--action-page`
and existing modules, that must also be the actual application's origin.
Those pages, modules and endpoints must be on that origin. No proxy, new
agent server, HOCON extension or business-endpoint CORS is required in this case. Existing
authentication, authorization and CSRF checks still apply.

For remote network loading, publish public `agent-manifest.json`,
`<network>.network.json`, `links.json`, `agent-mcp.json` and the generated
`.well-known` discovery JSON with `Access-Control-Allow-Origin: *`. Generated
hosting rules scope that header to these files. Action modules and bridge HTML
load on their own origin and communicate through validated MessagePorts; no CORS
on JavaScript is needed. The sandbox worker's CSP is a separate requirement.
External operations discovered with `--action-site` separately require the
target service's existing CORS support. The generated hosting rules do not and
cannot configure that external service.

For subpath deployment, `_headers` includes the `--site-url` prefix and must be
merged into the host-root configuration. Adjust it when moving the bundle;
the Apache `.htaccess` stays in the bundle directory. The host's framing policy
must allow the approved caller to embed the bridge; otherwise the runtime offers
a user-opened popup. Remote writes always use a popup with first-party review.
Third-party cookie restrictions can affect iframe reads; use `top-level` actions
for reads needing a first-party session. A host with an opener-isolating COOP
policy also needs a compatible bridge policy for popup messaging.

## Explicit adapters

No new HOCON syntax or action tools are needed. `--actions path/to/adapter.js`
copies the adapter to `actions.js` in the output. Without the flag, the generator
uses `<site-dir>/actions.js` when present. Adapter modules are not executed at build
time. Local boot loads the adapter before mounting the chat; a remote bridge loads
its own adapter and reports only data. Catalog injection happens per invocation,
so it covers both the manual and LangChain runners. `--no-cruse` suppresses the
action proposal prompt along with the other CRUSE instructions.

## Registration

Export `registerActions(actions)` and call `actions.register(definition)`. The
export may be async, but registration should not perform mutations or require
login; discovery can happen in an iframe without first-party cookies. Runtime
capability descriptions should not contain user data or secrets.

| Field | Meaning |
| --- | --- |
| `name` | Unique within this network; starts with a letter, then letters/digits/underscores/hyphens; maximum 80 characters. |
| `description` | What the model can propose. |
| `inputSchema` | Required object schema. |
| `outputSchema` | Optional result schema. |
| `effect` | `read`, `write` (default), or `irreversible`. This is a site-owned declaration, not a model assertion. |
| `availability` | `local-only` (default), `bridge`, or `top-level`. |
| `callerOrigins` | Exact permitted caller origins; defaults to `[]`, which denies all remote callers. `"*"` explicitly allows all callers; it does not waive confirmation. |
| `timeoutMs` | Default 180000; range 100–300000. Timeout means outcome unknown, not rolled back. |
| `execute(args, context)` | Returns JSON-serializable result; throws on failure. `context.requestId` is stable for that submission and `context.signal` supports cancellation for local requests. Bridge handlers also receive `callerOrigin`. |

All final widget submissions receive runtime review, including reads. Remote writes
add confirmation on their own origin; callers cannot bypass it by sending a
`confirmed` flag or by changing their copy of an action's effect. `top-level` makes
remote reads use a popup too. The bridge checks its own registered policy and schema.
It accepts requests only from its actual opener/parent on the permitted origin and
communicates over a transferred MessagePort. See the [HTML messaging standard](https://html.spec.whatwg.org/multipage/web-messaging.html).

Schemas support `object`, `array`, `string`, `integer`, `number`, `boolean`, nested
`properties`, `required`, `items`, `enum`, numeric `minimum`/`maximum`, string
`minLength`/`maxLength`, array `minItems`/`maxItems`, `format: "date"` or `"email"`,
and annotations `title`, `description`, `default`, `x-*`. Object arguments always
reject extra keys. Unsupported validation keywords fail registration. Data is
limited to 64 KB and schema depth to eight. The CRUSE renderer's form fields still
support only its existing scalar and enum-array controls; use a site-specific UI
or known constant arguments for more complex nested values.

The runtime prevents repeat clicks within a session. The endpoint must implement
idempotency using `requestId` for protection across reloads or fresh proposals.
An HTTP error, disconnect, timeout or invalid output produces `unknown`: the
underlying operation might have committed. Later operations in that submission
are `not_started`. There is no automatic retry, rollback or atomic multi-site commit.
Do not return `undefined`: return a meaningful result/receipt. Merely dispatching
a native form submit does not prove that the server accepted it.

## Proposal format

The runtime assigns a reference from the publishing base URL, network name and
registered action name. Agents must copy the exact reference from the catalog:

```json
{
  "version": 1,
  "components": [{
    "id": "visit",
    "kind": "form",
    "title": "Plan your visit",
    "schema": {
      "type": "object",
      "properties": {
        "seat": {"type": "string", "enum": ["inside", "outside", "either"]},
        "visit_date": {"type": "string", "format": "date"},
        "guests": {"type": "integer", "minimum": 1, "maximum": 12}
      },
      "required": ["seat", "visit_date", "guests"]
    },
    "submit": {"actions": [
      {"action": "http://127.0.0.1:8121/caller#save_preferences", "inputs": {"seat": "seat"}},
      {"action": "http://127.0.0.1:8122/venue#reserve_table", "inputs": {"date": "visit_date", "partySize": "guests"}}
    ]}
  }]
}
```

`inputs` maps action argument names to top-level form field names. These are plain
names, not `$fields` expressions or JavaScript. `arguments` supplies constants;
a key cannot appear in both. Maximum twelve actions per component. The runtime
validates every action's final arguments before starting any operation. Extra
unmapped form values are not sent to an action.

A ready action may instead be a component such as
`{"kind":"action","id":"reserve","label":"Request reservation","action":"EXACT_CATALOG_REF","arguments":{"date":"2026-12-15","partySize":3}}`.

Proposals are validated at each agent boundary. An agent can reference its own
site's catalog and validated action proposals returned by children it actually
called. Fetching another network does not grant that network access to caller
actions. Parents can combine child bindings without changing the action's origin.
The engine saves the final composition and executes by turn/component ID; an
interaction cannot supply a replacement binding. Rendering and model output alone
never invoke handlers. Results appear immediately in chat and enter history for
the next user turn; the browser does not automatically spend another LLM call.

## Existing websites

Generate into a dedicated output directory, then publish that directory at a
subpath such as `/agents/`. Do not generate directly over an existing website's
webroot: the generator writes its own `index.html`. For an embedded chat, add a
mount element to the existing page and use:

```html
<div id="agent-chat"></div>
<script type="module">
  import { boot } from "/agents/runtime/index.js";
  await boot("#agent-chat", {
    originUrl: location.origin + "/agents",
    sandboxWorkerUrl: "/agents/runtime/sandbox-worker.js"
  });
</script>
```

The adapter can import existing site modules (for example `/js/cart.js`) and call
their exported functions. `--actions` copies only the adapter; imported files must
already exist on the site or be shipped under `<site-dir>/assets/`, which nsDeploy
copies. Relative imports resolve beside the deployed `actions.js`, not beside the
original source file. Use absolute site paths or `new URL(..., import.meta.url)`
when routing matters. Avoid top-level imports/initialization that mutate state.

Local-only handlers may fill an existing form and call `requestSubmit()`, using
the site's normal validation and submit listener. To report actual success, await
the site's submission result through its existing application API. Navigation
can unload the chat, so bridge-capable handlers should call shared submission
functions or `fetch` and return a result. The bridge has no access to another tab's
DOM. A popup for `top-level` actions still loads the bridge document; adapters must
provide their own page UI there if needed. Login can occur in another tab on that
origin before confirmation. Passwords and payment details belong in site-owned UI,
not in a composed CRUSE form that the caller can read.

For integrations that already boot the runtime, `runtime.actions.register(...)`
also works (with the same definition). Registrations made only by `site.js` are
local; use the shared adapter for remote exposure.

## Hosting and trust boundaries

The generated assets require ordinary HTTP(S) hosting. There is no nsDeploy
application server or inbound MCP facade for browser actions. Server-side effects
still require an existing endpoint, serverless function or service. Use HTTPS in
production. The demo endpoint is an in-memory development fixture, not a backend
to deploy with real reservations.

Cross-origin network JSON/manifest loading still requires the existing static CORS
headers. Allow the bridge iframe in the caller's CSP, and allow permitted callers
in the bridge's framing policy. Discovery offers an explicit popup fallback when
framing fails. Popup communication requires an opener relationship; restrictive
Cross-Origin-Opener-Policy headers can prevent it. Popup blocking, unavailable
cookies and login failures are surfaced, not silently bypassed. A bridge request
to its own backend needs no CORS; requests to a different API origin still do.

The bridge is not backend authorization. Keep existing endpoint authentication,
CSRF checks, permission checks and business validation. Do not store secrets in
the public adapter, schemas or manifest. LLM keys never enter bridge requests.
Caller-origin permission is configured by the site owner, independently of the
runtime's consent to contact a peer network. Private Python stewards can still run
the data-only networks, but cannot execute these browser-only adapters.

See the [README walkthrough](../README.md#browser-actions-ande--nsdeploy--cruse)
for the ANDe prompt, build commands and two-origin browser checks.
