# CRUSE presentation protocol

Agents produce answer text plus an optional fenced `cruse-ui` JSON block. Their
caller receives `{cruse:1, text, presentation, source, protocol?}`. `protocol`
preserves AAOSA requirements and routing metadata. `source` identifies the network,
agent, origin and invocation. Invalid components are rejected and reported through
`presentationIssues`; parsed but unrenderable proposals remain in `unrenderedProposals`
for the parent to recover their facts and requirements. Useful answer text survives. A completely invalid UI-only
reply falls back to a readable retry message.

Every parent sees its children's text and proposals in the ordinary tool results.
It synthesizes its own answer and presentation during its final model response;
there is no extra presentation-model call. Child components are proposals, not
unconditional instructions to display. Distinct requirements and conflicting
claims must be preserved. Redundant questions should be merged by meaning, and
questions answered in the conversation should be omitted. Exact duplicate
components are removed mechanically; semantic choices remain the model's job.

Agents run on neuro-san's loop. The engine adds each agent's presentation context
to its instructions when it prepares a network for a session, and parses the front
man's final answer. Within a network, a child's reply reaches its parent as neuro-san
returns it, with its `cruse-ui` block. A partner network's reply is parsed and returned
to the agent that called it as the structured result. `Engine.runTurn` returns the
final result with a `turnId`;
`Engine.run` continues to return answer text for older callers. Only `runTurn`'s
final composition is rendered. `presentation_proposal` trace entries show child
proposals and validation issues without adding them to the chat.

## Composition

```json
{
  "version": 1,
  "components": [
    {
      "id": "availability",
      "kind": "table",
      "title": "Availability",
      "columns": ["Vehicle", "Status"],
      "rows": [["Known vehicle", "Awaiting confirmation"]]
    }
  ]
}
```

IDs should be stable across revisions. The runtime assigns an ID when absent and
resolves duplicates within a composition. One composition may include several
complementary components. Typically it should present at most one focused input
step; this is a model instruction, not a hard limit that discards distinct needs.
Legacy single-widget `cruse-ui` or recognizable `json` fences still work.

| Kind | Content |
| --- | --- |
| `form` | `schema` with `properties`, optional `required`, and `submitLabel` |
| `choice` | `options: [{title, subtitle?, meta?, value}]` |
| `confirm` | `confirmText`, optional `confirmLabel`, `cancelText`, `cancelLabel` |
| `info` | `fields: {label: value}` |
| `report` | `markdown` with paragraphs, headings, lists, emphasis, code, links and tables |
| `table` | String `columns` and equally sized scalar `rows` |
| `chart` | `chartType: "bar" or "line"`, `labels`, `series: [{name, values}]`, `summary`, optional `unit` |
| `html` | `html` containing semantic presentational markup |

Chart series must contain finite numbers, match the labels, and use known data.
The current limits are 8 series and 120 labels. Charts include an accessible summary
and expandable table. The renderer draws SVG itself; model-authored SVG is not
accepted. HTML supports headings, sections, lists, tables, details/summary and safe
HTTP(S)/mailto links. Scripts, styles, event handlers, external resources, embeds,
SVG and HTML form controls are removed. Use a form or chart component for those
functions. Raw HTML in Markdown is displayed literally.

Form controls support strings, dates, numbers, integers, booleans, enums, radio
groups, textareas and arrays with enum items. Numeric submissions retain numeric
types, booleans retain boolean types, and choices send `value`, not just their label.
Submissions include `{turnId, componentId, kind, values? / value? / action?}`.
neuro-san's chat context keeps each final answer, its presentation included, so a
submission's component ID refers back to it. Plain chat can supplement or
correct a submitted form. Unsubmitted drafts remain local. The welcome widget is
kept available when a user starts by typing.

## Development checks

The runtime's neuro-san bundle is built from `runtime-build/` (see the README).

```sh
(cd runtime-build && npm install && npm run build)
npm test
venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

`npm test` runs the runtime regression checks and the CRUSE parsing and
normalization tests. For DOM behavior and visual QA,
serve the repository with `python -m http.server 8119 --bind 127.0.0.1` and open
`http://127.0.0.1:8119/tests/cruse-browser.html`. It reports browser checks and leaves
a clearly labeled illustrative report/table/chart/form response to inspect. No
provider key is used by that page. Test live model consolidation separately using
a regenerated deployment and the site's BYOK settings.
