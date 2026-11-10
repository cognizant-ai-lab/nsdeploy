# Deploying an agent network to Agentic City from outside

Everything below is a plain HTTPS call — no SDK, no VPN. Tested against the live
service.

```bash
BASE=https://agentic-city.example.com
TOKEN=<ask the Agentic City owner for this>
```

Every route except `GET /health` needs `Authorization: Bearer $TOKEN`.

---

## 1. Check the service is up and has room

```bash
curl -s $BASE/health | jq .
```

```json
{
  "status": "ok",
  "port_pool": { "range": "8100-8119", "capacity": 20, "reserved": [] },
  "deployments": {},
  "warnings": []
}
```

`capacity` minus the number of `reserved` ports is how many more networks can run.
A deploy is refused once that reaches zero.

---

## 2. Deploy a network

Two forms. Use the second from scripts.

### Multipart (a file on disk)

```bash
curl -X POST $BASE/deployments \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@my_network.hocon" \
  -F "org_name=Your Team Name"
```

### Raw body (piping, or generating the HOCON on the fly)

```bash
curl -X POST "$BASE/deployments/raw?name=my_network&org_name=Your%20Team%20Name" \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @my_network.hocon
```

`name` is **required** on the raw form — there is no filename to fall back on.

Both return **`202 Accepted`** immediately, *before* the build starts:

```json
{ "id": "e7e6d4c29d3a", "name": "my_network", "status": "queued", "port": 8100,
  "url": null, "org_name": "Your Team Name" }
```

Keep the `id`.

### Optional fields

| Field | Default | Notes |
|---|---|---|
| `org_name` | `Unattributed` | created on first use; use your team name so your rows are identifiable |
| `name` | the file's basename | becomes the network name |
| `theme` | service default (on) | deploy-time LLM theming; adds time to the build |
| `theme_prompt` | empty | extra design instructions, ≤ 4000 chars |
| `cruse` | `true` | generative UI |
| `ttl_seconds` | `0` | `0` = never expires |

### What the filename becomes

The network name is derived from the filename stem, so `my_network.hocon` becomes
`my_network`. It must be 1-64 characters of letters, digits, `_` or `-`.

A browser's duplicate-download marker is stripped, so
`my_network (1).hocon` also deploys as `my_network` — no need to rename a file
pulled out of Downloads.

Note the consequence: **re-uploading the same name under the same organization
replaces that deployment** rather than creating a second one. The response carries
`"replaced": true`, and the id, port and URL stay the same. That is how you push a
revised network.

---

## 3. Wait for it to build

`/wait` blocks until the deployment settles, and returns **`504` while it is still
building** — so loop:

```bash
ID=e7e6d4c29d3a
while true; do
  RESP=$(curl -s -w '\n%{http_code}' "$BASE/deployments/$ID/wait?timeout=60" \
           -H "Authorization: Bearer $TOKEN")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
  [ "$CODE" = "200" ] && break
  echo "still building..."
done
echo "$BODY" | jq '{status, url, error}'
```

A warm build is seconds; a cold one fetches tool definitions from GitHub and can take
around 20-30 seconds. Theming adds more.

```json
{ "status": "ready",
  "url": "https://agentic-city.example.com:8100",
  "error": null }
```

That `url` is the live site — open it in a browser. It is HTTPS with a real
certificate, on a non-standard port.

On failure, `status` is `failed` and `error` carries the reason.

---

## 4. Read the build log

```bash
curl -s "$BASE/deployments/$ID/logs?tail=150" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.lines[]'
```

This is where a failed build explains itself, and where theming reports whether it
succeeded or fell back to the default look.

---

## 5. List, stop, remove

```bash
# everything, newest first
curl -s $BASE/deployments -H "Authorization: Bearer $TOKEN" \
  | jq -r '.deployments[] | "\(.id)  \(.name)  \(.status)  \(.url // "-")"'

# just yours
curl -s "$BASE/deployments?org_id=<your org id>" -H "Authorization: Bearer $TOKEN"

# rebuild a stopped one from its stored HOCON
curl -X POST "$BASE/deployments/$ID/restart" -H "Authorization: Bearer $TOKEN"

# stop and remove, freeing the port
curl -X DELETE "$BASE/deployments/$ID" -H "Authorization: Bearer $TOKEN"
```

Please delete networks you are finished with — ports are a shared, limited pool.

---

## 6. Endpoints on a deployed network

Once `ready`, the site exposes these under its own URL:

| Path | What |
|---|---|
| `/` | the site |
| `/agent-manifest.json` | brand, routers, linking metadata |
| `/.well-known/nsdeploy-agent.json` | machine-readable agent description |
| `/mcp` | MCP facade for the whole network |
| `/v1/chat/completions` | mock LLM router |
| `/byok/v1/chat/completions` | bring-your-own-key proxy |

---

## 7. Limits and gotchas

| | |
|---|---|
| HOCON size | 512 KiB |
| Concurrent networks | 20 (service-wide, shared with everyone) |
| Concurrent builds | 2 — further uploads queue |
| Name | 1-64 chars, letters/digits/`_`/`-` |
| Site URLs | `https://<host>:<port>`, ports 8100 upwards |

**The HOCON must be a HOCON object**, starting with `{`. A top-level array fails with
`ValueError: dictionary update sequence element #0 has length 5; 2 is required`, which
is not an obvious message — if you see it, check the file begins with `{` and not `[`.

**Egress to the site ports.** Sites are served on ports 8100+. If your network blocks
outbound traffic to non-standard ports, the API will work but the deployed sites will
not open.

---

## 8. Please read: the token is shared

There is a **single token for the whole service**, not one per team. It identifies
"someone allowed to use this service", never *which* team — so anyone holding it can
stop or delete **any** network, including other teams'.

Organization names are attribution labels, not security boundaries.

So: set `org_name` to your team so your rows are identifiable, only delete ids you
created, and treat the token as shared infrastructure credentials rather than your own.

Also note that **an uploaded HOCON runs as the service** — it resolves the Python
classes the network names and installs their dependencies. Upload only definitions you
trust.
