# Add Agent to an existing website

The embed installer uses Node.js 20+ and the checked-in browser runtime. It needs no Python,
package installation, application server or hosted nsdeploy deployment. Visitors need only a browser.
The result is a static bundle with an **Agent** launcher, chat, CRUSE responses and BYOK settings.

Run from this repository:

```sh
node scripts/embed.mjs examples/link_demo_airline.hocon /path/to/website
```

You can supply an HTML file instead of a directory. With a directory, the default entry is `index.html`;
use `--entry pages/visit.html` to select a different page. Assets go under
`assets/nsdeploy/<hocon-filename>/` in the selected website directory. Serve that directory over HTTP(S),
not by opening the HTML with `file://`. Use HTTPS for real credentials.

## Floating and inline presentation

The default floating launcher is labeled **Agent**. Clicking opens a compact chat panel;
closing it preserves the conversation and draft. Escape closes the panel and restores launcher focus.
The launcher's separate dismiss button hides it for the current browser session. Mobile uses a full-screen panel.
The runtime loads on first open. The widget uses a shadow root for its controls and an iframe for the agent UI.
It does not apply agent page styles to the surrounding website.

To place the panel in a designer-selected part of the page:

```sh
node scripts/embed.mjs examples/link_demo_airline.hocon /path/to/website --mode inline
```

Move the generated `<nsdeploy-widget>` element into the desired container, leaving the module script on the page.
Set its width and height using your website stylesheet; inline mode defaults to 650 pixels high.
If moving the element out of the marked installer block, manage the snippet manually afterward.
Both modes use an iframe: neither can automatically discover forms in the surrounding parent page.
Existing actions configured inside a supplied static bundle retain their runtime behavior and confirmations.

The frame exposes the ordinary BYOK setup and rich chat responses. Developer graphs are hidden in the compact view.
An **Open full page** link opens the bundle's original `index.html` when one is supplied.
BYOK profiles follow the existing runtime's browser storage behavior. An iframe on the same origin does not
isolate credentials from other scripts on that origin; the host website must be trusted.

## Input and static hosting limits

The Python-free builder supports the browser parser's self-contained HOCON subset: objects, arrays, comments,
quoted/unquoted keys, triple-quoted instructions and standard scalar values. It validates the agent graph,
enables CRUSE and exposes unresolved peer names through the runtime's link flow.
Python/toolbox entries are explicitly reported and omitted along with references to them.
No server or Python processes are started, and no inbound MCP facade is published.

Includes, substitutions, dotted keys and array appends are rejected. For a network already built by nsdeploy,
reuse its static bundle instead of compiling the HOCON again:

```sh
node scripts/embed.mjs network.hocon /path/to/website --bundle /path/to/static-bundle
```

The HOCON filename identifies the network in this mode; the bundle is authoritative and the HOCON is not recompiled.
Hosted bundles are rejected. The installer copies the bundle's existing runtime, network and action assets and
adds the compact page. For portable installation, supply a bundle built with relative asset and manifest paths.
Canonical URLs and custom hosting headers in an existing bundle must match its final deployment location.

LLM calls go directly to the visitor's selected OpenAI-compatible provider; external MCP calls also go directly
from the browser. Those services must permit browser CORS. A static widget cannot provide a CORS proxy or execute
Python tools. Your website's content policy must allow the module, frame and configured provider connections.
If exposing network data to agents on other origins, configure CORS for the public manifest/network/link JSON.
If using JavaScript coded-tool bundles, retain the sandbox-worker policy from the supplied bundle's hosting guide.
The iframe is layout isolation, not a security boundary against scripts from the same origin.

## Safe edits and framework projects

```sh
node scripts/embed.mjs network.hocon /path/to/website --dry-run
node scripts/embed.mjs network.hocon /path/to/website --remove
```

The installer adds a marked block before the closing body tag. Repeating an install updates that block without
duplicating it. Removal restores the surrounding HTML and retains assets in case another page uses them.
Generated-file hashes protect designer edits from being overwritten on later installs. Existing unmanaged asset
directories, symlinks, incomplete markers and ambiguous entry paths produce errors before the HTML is edited.
Keep source and generated assets in your normal version-control or backup workflow.

For framework applications, target a built HTML entry or put the generated element and module import in your
framework's layout manually. The installer does not rewrite JSX, Vue components or server templates. Pages with
a `<base>` element need explicit asset URLs and a manually placed snippet. Add the snippet to each desired page;
it does not inject into every HTML file automatically. Conversation state persists across collapse/reopen, not
across page navigation or a reload. BYOK Apply reloads only the frame.

## Try the example and tests

Copy `examples/widget/index.html` into a disposable website folder and run the command above against that folder.
Add `--mock-llm` for a deterministic demo without a real API key. Mock mode is labeled in the panel;
the default build requires BYOK and never silently falls back to a mock.

```sh
node --test tests/embed.test.mjs
node tests/embed-browser.mjs
```

The browser test requires Playwright and Chrome/Chromium as development tools. It creates temporary example sites
and a Node static server, exercises both modes, chat, CRUSE forms, dismissal, preserved drafts, mobile sizing and
BYOK setup, then saves desktop/mobile screenshots. It mocks provider discovery and never sends a real API key.
Set `NSDEPLOY_PLAYWRIGHT_MODULE` to a Playwright module path and `NSDEPLOY_CHROME` to a Chrome executable if needed.
