"""Bounded, read-only discovery of public forms and JSON OpenAPI 3 operations.

The lock is publisher-reviewed data. No page JavaScript is executed or copied.
"""
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_BYTES = 2_000_000
SENSITIVE = re.compile(r"password|passwd|secret|token|authorization|api.?key|credit.?card|card.?number|cvv", re.I)


def public_url(value):
    u = urlsplit(value)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.fragment or "\\" in value:
        raise ValueError("Action sources require HTTP(S) URLs without credentials or fragments.")
    return value


def origin(value):
    u = urlsplit(public_url(value))
    return f"{u.scheme}://{u.netloc}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Discovery does not follow redirects; supply the final URL.")


def fetch(url, method="GET", headers=None):
    public_url(url)
    request = Request(url, method=method,
                      headers={"User-Agent": "Mozilla/5.0 (compatible; nsdeploy-discovery/1)", **(headers or {})})
    try:
        response = build_opener(NoRedirect).open(request, timeout=20)
    except HTTPError as exc:
        if method != "OPTIONS":
            raise ValueError(f"HTTP {exc.code} reading {url}") from exc
        response = exc
    with response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("Discovery response exceeds 2 MB.")
        return data.decode("utf-8"), dict(response.headers.items()), response.status


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.forms, self.links, self.scripts = [], [], 0
        self.form, self.option = None, None
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        attrs = {k: v or "" for k, v in attrs.items()}
        if tag == "script":
            self.scripts += 1
        if tag in ("a", "link") and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag == "form":
            self.form = {"attributes": attrs, "controls": []}
            self.forms.append(self.form)
        elif self.form is not None and tag in ("input", "select", "textarea", "button", "option"):
            control = {"tag": tag, "attributes": attrs}
            self.form["controls"].append(control)
            if tag == "option":
                control["text"] = ""
                self.option = control

    def handle_data(self, text):
        if self.option is not None:
            self.option["text"] += text

    def handle_endtag(self, tag):
        if tag == "form":
            self.form = None
        if tag == "option":
            self.option = None


def fingerprint(form):
    return hashlib.sha256(
        json.dumps(form, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def action_name(method, url):
    path = re.sub(r"[^a-zA-Z0-9]+", "_", urlsplit(url).path).strip("_")[:45] or "root"
    digest = hashlib.sha256(f"{method} {url}".encode()).hexdigest()[:8]
    return f"{method.lower()}_{path}_{digest}"


def form_action(page_url, form, index):
    attrs = form["attributes"]
    if not attrs.get("action") or any(k.startswith("on") for k in attrs):
        raise ValueError("Form has no native action or uses inline JavaScript.")
    endpoint = public_url(urljoin(page_url, attrs["action"]))
    if origin(endpoint) != origin(page_url):
        raise ValueError("Form submits to a different origin; explicit API description needed.")
    method = attrs.get("method", "get").upper()
    encoding = attrs.get("enctype", "application/x-www-form-urlencoded").lower()
    if method not in ("GET", "POST") or encoding != "application/x-www-form-urlencoded":
        raise ValueError("Build-time forms support native GET/POST URL-encoded submissions.")
    props, required, options = {}, [], {}
    current_select = None
    for control in form["controls"]:
        tag, a = control["tag"], control["attributes"]
        name, kind = a.get("name"), a.get("type", "text").lower()
        if tag == "option":
            if current_select and "disabled" not in a:
                options.setdefault(current_select, []).append(a.get("value", control["text"].strip()))
            continue
        if tag != "select":
            current_select = None
        if (any(k.startswith("on") or k.startswith("form") for k in a)
                or kind in ("password", "hidden", "file", "image") or (name and SENSITIVE.search(name))):
            raise ValueError("Form needs JavaScript, credentials, hidden state, or unsupported controls.")
        if not name or "disabled" in a:
            continue
        if tag == "button" or kind in ("submit", "button", "reset") or "readonly" in a:
            raise ValueError("Named buttons or readonly fields need runtime same-origin discovery.")
        if name in props and kind not in ("radio", "checkbox"):
            raise ValueError("Repeated non-choice fields are unsupported.")
        schema = {"type": "string", "title": a.get("aria-label", name), "maxLength": 4096}
        if kind in ("radio", "checkbox"):
            options.setdefault(name, []).append(a.get("value", "on"))
            schema = ({"type": "array", "items": {"type": "string"}, "maxItems": 100} if kind == "checkbox"
                      else {"type": "string"})
            if kind == "checkbox" and "required" in a:
                schema["minItems"] = 1
        elif tag == "select":
            current_select = name
            if "multiple" in a:
                schema = {"type": "array", "items": {"type": "string"}, "maxItems": 100}
        elif kind == "number":
            schema = {"type": "number"}
            for html, key in (("min", "minimum"), ("max", "maximum")):
                if html in a:
                    schema[key] = float(a[html])
        elif kind in ("email", "date"):
            if "required" in a:
                schema["format"] = kind
            else:
                schema["description"] = (f"Optional {kind}; may be left blank. "
                                         "Validated against the source form before submission.")
        if kind == "time":
            schema["description"] = (f"Time as HH:MM; minimum {a.get('min', 'unspecified')}, "
                                     f"maximum {a.get('max', 'unspecified')}, step {a.get('step', '60')} seconds.")
        if "maxlength" in a:
            schema["maxLength"] = int(a["maxlength"])
        props[name] = schema
        if "required" in a:
            required.append(name)
    for name, values in options.items():
        if not values:
            continue
        schema = props[name]
        (schema["items"] if schema["type"] == "array" else schema)["enum"] = list(dict.fromkeys(values))
    if not props:
        raise ValueError("Form has no supported named input fields.")
    return {"name": action_name(method, page_url + f"?form={index}"),
            "description": (f"Submit native form {index + 1} from {page_url}. "
                            "HTTP response is evidence of submission, not business acceptance."),
            "effect": "write",
            "inputSchema": {"type": "object", "properties": props, "required": list(dict.fromkeys(required)),
                            "additionalProperties": False},
            "request": {"kind": "form", "url": endpoint, "method": method, "page": page_url, "index": index,
                        "fingerprint": fingerprint(form)},
            "evidence": {"source": page_url, "kind": "native-form"}, "enabled": False}


def resolve_ref(schema, spec, depth=0):
    if depth > 8:
        raise ValueError("Recursive OpenAPI references unsupported.")
    if "$ref" not in schema:
        return schema
    ref = schema["$ref"]
    if not ref.startswith("#/"):
        raise ValueError("Only local OpenAPI references are supported.")
    value = spec
    for part in ref[2:].split("/"):
        value = value[part.replace("~1", "/").replace("~0", "~")]
    return resolve_ref(value, spec, depth + 1)


def scalar_schema(schema, spec):
    schema = resolve_ref(schema, spec)
    allowed = {"type", "title", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "format",
               "default", "example", "deprecated"}
    if schema.get("type") not in ("string", "number", "integer", "boolean") or set(schema) - allowed:
        raise ValueError("Only scalar API parameters and explicit free-form JSON body fields are supported.")
    if schema.get("format") not in (None, "email", "date", "int32", "int64", "float", "double"):
        raise ValueError("Unsupported API parameter format.")
    result = {k: v for k, v in schema.items() if k not in ("example", "deprecated", "format")}
    if schema.get("format") in ("email", "date"):
        result["format"] = schema["format"]
    return result


def api_actions(spec, source, issues):
    if not str(spec.get("openapi", "")).startswith("3."):
        raise ValueError("Supply an OpenAPI 3 JSON specification.")
    result = []
    for path, item in spec.get("paths", {}).items():
        for method, op in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            label = f"{method.upper()} {path}"
            try:
                if (op.get("security", spec.get("security")) or SENSITIVE.search(path)
                        or re.search(r"/(?:admin|login|logout|register|payment)(?:/|$)", path, re.I)):
                    raise ValueError("Authenticated or sensitive operation excluded.")
                servers = op.get("servers", item.get("servers", spec.get("servers", [])))
                if (not servers or "{" in servers[0]["url"] or not path.startswith("/") or path.startswith("//")
                        or "?" in path):
                    raise ValueError("API requires a fixed server URL and path.")
                endpoint = public_url(servers[0]["url"].rstrip("/") + path)
                props, required, bindings, json_fields = {}, [], [], []
                for parameter in item.get("parameters", []) + op.get("parameters", []):
                    p = resolve_ref(parameter, spec)
                    name = p["name"]
                    if p["in"] not in ("path", "query") or SENSITIVE.search(name):
                        raise ValueError("Header/cookie/credential parameters excluded.")
                    if (name in props
                            or p.get("style", "simple" if p["in"] == "path" else "form") not in ("simple", "form")
                            or p.get("allowReserved")):
                        raise ValueError("Ambiguous or unsupported parameter encoding.")
                    props[name] = scalar_schema(p["schema"], spec)
                    bindings.append({"name": name, "in": p["in"]})
                    if p.get("required") or p["in"] == "path":
                        required.append(name)
                body = resolve_ref(op.get("requestBody", {}), spec)
                if body:
                    if method == "get" or set(body.get("content", {})) != {"application/json"}:
                        raise ValueError("Only JSON API request bodies are supported.")
                    schema = resolve_ref(body["content"]["application/json"]["schema"], spec)
                    if (schema.get("type") != "object" or not schema.get("properties")
                            or set(schema) - {"type", "properties", "required", "additionalProperties", "description",
                                              "title"}):
                        raise ValueError("API body needs explicit object properties.")
                    for name, field in schema["properties"].items():
                        if name in props or SENSITIVE.search(name):
                            raise ValueError("Conflicting or credential body field.")
                        field = resolve_ref(field, spec)
                        if (field.get("type") == "object" and field.get("additionalProperties") is True
                                and not field.get("properties")
                                and not (set(field) - {"type", "additionalProperties", "description", "title"})):
                            props[name] = {"type": "string", "maxLength": 16000,
                                           "description": "JSON object text. " + field.get("description", ""),
                                           "x-json": True}
                            json_fields.append(name)
                        else:
                            props[name] = scalar_schema(field, spec)
                        bindings.append({"name": name, "in": "body"})
                    required += schema.get("required", [])
                if set(re.findall(r"\{([^}]+)\}", endpoint)) != {p["name"] for p in bindings if p["in"] == "path"}:
                    raise ValueError("Path parameters do not match the endpoint template.")
                result.append({"name": action_name(method, endpoint),
                               "description": op.get("summary", label) + f" ({method.upper()} {endpoint})",
                               "effect": ("read" if method == "get"
                                          else ("irreversible" if method == "delete" else "write")),
                               "inputSchema": {"type": "object", "properties": props, "required": required,
                                               "additionalProperties": False},
                               "request": {"kind": "http", "url": endpoint, "method": method.upper(),
                                           "bindings": bindings, "jsonFields": json_fields, "body": bool(body)},
                               "evidence": {"source": source, "kind": "openapi"}, "enabled": False})
            except (ValueError, KeyError, TypeError) as exc:
                issues.append({"source": source, "operation": label, "reason": str(exc)})
    return result


def cors_probe(action, site_url, fetcher):
    request = action["request"]
    urls = [request["url"]] + ([request["page"]] if request["kind"] == "form" else [])
    checks = []
    for i, url in enumerate(urls):
        if not site_url:
            checks.append({"url": url, "status": "unverified", "reason": "No --site-url provided."})
            continue
        if origin(url) == origin(site_url):
            checks.append({"url": url, "status": "same-origin"})
            continue
        method = request["method"] if i == 0 else "GET"
        headers = {"Origin": origin(site_url), "Access-Control-Request-Method": method}
        if request.get("body") and i == 0:
            headers["Access-Control-Request-Headers"] = "content-type"
        try:
            _, response, status = fetcher(re.sub(r"\{[^}]+\}", "nsdeploy-probe", url), "OPTIONS", headers)
            response = {k.lower(): v for k, v in response.items()}
            allow = response.get("access-control-allow-origin") in ("*", origin(site_url))
            methods = {x.strip().upper() for x in response.get("access-control-allow-methods", "").split(",")}
            allowed_headers = {x.strip().lower() for x in response.get("access-control-allow-headers", "").split(",")}
            preflight = (200 <= status < 300 and allow and (method in methods or "*" in methods)
                         and ("Access-Control-Request-Headers" not in headers
                              or bool(allowed_headers & {"*", "content-type"})))
            checks.append({"url": url, "status": "preflight-permitted" if preflight else "unverified",
                           "httpStatus": status})
        except (ValueError, OSError) as exc:
            checks.append({"url": url, "status": "unverified", "reason": str(exc)})
    return {"checks": checks,
            "note": ("OPTIONS only; actual browser execution and response CORS remain unverified. "
                     "No business operation was run.")}


def discover(site, spec_path=None, site_url="", max_pages=6, fetcher=fetch):
    public_url(site)
    if not 1 <= max_pages <= 20:
        raise ValueError("--action-max-pages must be between 1 and 20.")
    actions, issues, visited, queue = [], [], [], [site]
    if spec_path:
        raw = (fetcher(spec_path)[0] if str(spec_path).startswith(("https://", "http://"))
               else Path(spec_path).read_text())
        actions += api_actions(json.loads(raw), str(spec_path), issues)
    while queue and len(visited) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.append(url)
        try:
            raw, headers, _ = fetcher(url)
            if raw.lstrip().startswith("{"):
                actions += api_actions(json.loads(raw), url, issues)
                continue
            page = Page(raw)
            for index, form in enumerate(page.forms):
                try:
                    actions.append(form_action(url, form, index))
                except (ValueError, KeyError) as exc:
                    issues.append({"source": url, "form": index + 1, "reason": str(exc)})
            if page.scripts:
                issues.append({"source": url,
                               "reason": ("Page JavaScript was not executed. "
                                          "JS-only actions require a documented API or site-owned adapter.")})
            for href in page.links:
                target = urlsplit(urljoin(url, href))
                if target.scheme not in ("http", "https") or target.username or target.password:
                    continue
                target = urlunsplit((target.scheme, target.netloc, target.path, "", ""))
                # Only explicit documentation/form navigation; never crawl query links,
                # guessed endpoints, logout links or submit forms to explore the site.
                if ("?" not in href and origin(target) == origin(site)
                        and re.search(r"(?:form|docs?|openapi|swagger|spec)(?:[./_-]|$)", urlsplit(target).path, re.I)
                        and not re.search(r"logout|delete|remove|checkout", target, re.I)):
                    if target not in visited and target not in queue:
                        queue.append(target)
        except (ValueError, OSError) as exc:
            issues.append({"source": url, "reason": str(exc)})
    # Identical operations reached from multiple documentation links are one capability.
    actions = list({a["name"]: a for a in actions}.values())
    if len(actions) > 100:
        raise ValueError("Discovery found more than 100 operations; narrow the source specification.")
    for action in actions:
        action["cors"] = cors_probe(action, site_url, fetcher)
    return {"version": 1, "source": site, "spec": str(spec_path) if spec_path else None,
            "siteOrigin": origin(site_url) if site_url else None, "visited": visited,
            "actions": actions, "issues": issues}


def prepare_actions(lock_path, site=None, spec=None, site_url="", refresh=False, include_all=False, allow=(),
                    max_pages=6):
    lock_path = Path(lock_path)
    if lock_path.exists() and not refresh:
        doc = json.loads(lock_path.read_text())
        if doc.get("version") != 1 or not isinstance(doc.get("actions"), list):
            raise ValueError("Invalid discovered-actions lock file.")
        if (site and site != doc.get("source")) or (spec and str(spec) != doc.get("spec")):
            raise ValueError("Action source changed; use --action-refresh to rediscover and review.")
    else:
        if not site:
            raise ValueError("--action-site is required for initial discovery or refresh.")
        doc = discover(site, spec, site_url, max_pages)
    unknown = set(allow) - {a["name"] for a in doc["actions"]}
    if unknown:
        raise ValueError("Unknown --action-allow names: " + ", ".join(sorted(unknown)))
    for action in doc["actions"]:
        if include_all or action["name"] in allow:
            action["enabled"] = True
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    count = sum(a.get("enabled") is True for a in doc["actions"])
    print(f"   discovered actions: {count}/{len(doc['actions'])} enabled; review {lock_path}")
    for issue in doc["issues"]:
        print(f"   discovery note: {issue['source']}: {issue['reason']}")
    if not count:
        raise ValueError(f"No discovered actions enabled. Review {lock_path}, set selected enabled fields to true, "
                         "or use --action-allow NAME. "
                         "--action-include-all enables all supported candidates for a test site.")
    if doc.get("siteOrigin") != (origin(site_url) if site_url else None):
        print("   WARNING: publishing origin differs from the discovery checks; browser CORS needs verification.")
    return doc
