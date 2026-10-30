# Browser action adapters and CRUSE bindings

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
