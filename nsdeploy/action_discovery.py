"""Bounded, read-only discovery of public forms and JSON OpenAPI 3 operations.

The lock is publisher-reviewed data. No page JavaScript is executed or copied.
"""
import hashlib
from html.parser import HTMLParser
from http.client import HTTPMessage
from http.client import HTTPResponse
import json
from pathlib import Path
import re
from typing import Any
from typing import Callable
from typing import Dict
from typing import IO
from typing import List
from typing import NoReturn
from typing import Optional
from typing import Sequence
from typing import Set
from typing import Tuple
from typing import Union
from urllib.error import HTTPError
from urllib.parse import SplitResult
from urllib.parse import urljoin
from urllib.parse import urlsplit
from urllib.parse import urlunsplit
from urllib.request import Request
from urllib.request import build_opener
from urllib.request import HTTPRedirectHandler

MAX_BYTES: int = 2_000_000
SENSITIVE: re.Pattern[str]
SENSITIVE = re.compile(r"password|passwd|secret|token|authorization|api.?key|credit.?card|card.?number|cvv", re.I)


def public_url(value: str) -> str:
    """
    Validate that a URL is a public HTTP(S) URL without credentials or fragments.

    :param value: The URL to validate.
    :return: The unchanged URL.
    :raises ValueError: If the URL is not an acceptable public HTTP(S) URL.
    """
    u: SplitResult = urlsplit(value)
    # pylint: disable-next=too-many-boolean-expressions  # flat validation list
    if (u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.fragment
            or "\\" in value):
        raise ValueError("Action sources require HTTP(S) URLs without credentials or fragments.")
    return value


def origin(value: str) -> str:
    """
    Return the scheme and network location of a public URL.

    :param value: The URL to inspect.
    :return: The origin string, e.g. "https://example.com".
    :raises ValueError: If the URL is not an acceptable public HTTP(S) URL.
    """
    u: SplitResult = urlsplit(public_url(value))
    return f"{u.scheme}://{u.netloc}"


class NoRedirect(HTTPRedirectHandler):
    """
    Redirect handler that refuses every redirect so discovery reads only the supplied URL.
    """

    # pylint: disable-next=too-many-arguments,too-many-positional-arguments  # base-class signature
    def redirect_request(self, req: Request, fp: IO[bytes], code: int, msg: str, headers: HTTPMessage,
                         newurl: str) -> NoReturn:
        """
        Refuse the redirect.

        :param req: The original request.
        :param fp: The response file object.
        :param code: The HTTP status code.
        :param msg: The HTTP status message.
        :param headers: The response headers.
        :param newurl: The redirect target URL.
        :return: Never returns.
        :raises ValueError: Always, because discovery does not follow redirects.
        """
        raise ValueError("Discovery does not follow redirects; supply the final URL.")


def fetch(url: str, method: str = "GET", headers: Optional[Dict[str, str]] = None) -> Tuple[str, Dict[str, str], int]:
    """
    Fetch a public URL without following redirects, bounded to MAX_BYTES.

    :param url: The URL to fetch.
    :param method: The HTTP method to use.
    :param headers: Optional extra request headers.
    :return: A tuple of (decoded body text, response headers dict, HTTP status).
    :raises ValueError: On a non-public URL, an HTTP error (except for OPTIONS) or an oversized response.
    """
    public_url(url)
    request: Request
    request = Request(url, method=method,
                      headers={"User-Agent": "Mozilla/5.0 (compatible; nsdeploy-discovery/1)", **(headers or {})})
    response: Union[HTTPResponse, HTTPError]
    try:
        response = build_opener(NoRedirect).open(request, timeout=20)
    except HTTPError as exc:
        if method != "OPTIONS":
            raise ValueError(f"HTTP {exc.code} reading {url}") from exc
        response = exc
    with response:
        data: bytes = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("Discovery response exceeds 2 MB.")
        return data.decode("utf-8"), dict(response.headers.items()), response.status


class Page(HTMLParser):
    """
    HTML parser that collects forms, their controls, links and the script count of a page.
    """

    def __init__(self, text: str) -> None:
        """
        Parse the page text immediately.

        :param text: The HTML text of the page.
        """
        super().__init__(convert_charrefs=True)
        self.forms: List[Dict[str, Any]]
        self.links: List[str]
        self.scripts: int
        self.forms, self.links, self.scripts = [], [], 0
        self.form: Optional[Dict[str, Any]]
        self.option: Optional[Dict[str, Any]]
        self.form, self.option = None, None
        self.feed(text)

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        """
        Record scripts, links, forms and form controls.

        :param tag: The lowercase tag name.
        :param attrs: The list of (name, value) attribute pairs.
        """
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
            control: Dict[str, Any] = {"tag": tag, "attributes": attrs}
            self.form["controls"].append(control)
            if tag == "option":
                control["text"] = ""
                self.option = control

    def handle_data(self, data: str) -> None:
        """
        Accumulate the text of the current option element.

        :param data: The text data.
        """
        if self.option is not None:
            self.option["text"] += data

    def handle_endtag(self, tag: str) -> None:
        """
        Close the current form or option element.

        :param tag: The lowercase tag name.
        """
        if tag == "form":
            self.form = None
        if tag == "option":
            self.option = None


def fingerprint(form: Dict[str, Any]) -> str:
    """
    Compute a stable SHA-256 fingerprint of a parsed form.

    :param form: The parsed form dictionary.
    :return: The hexadecimal digest.
    """
    canonical: str = json.dumps(form, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def action_name(method: str, url: str) -> str:
    """
    Build a readable, unique action name from a method and URL.

    :param method: The HTTP method.
    :param url: The URL of the operation.
    :return: The action name.
    """
    path: str = re.sub(r"[^a-zA-Z0-9]+", "_", urlsplit(url).path).strip("_")[:45] or "root"
    digest: str = hashlib.sha256(f"{method} {url}".encode()).hexdigest()[:8]
    return f"{method.lower()}_{path}_{digest}"


# pylint: disable-next=too-many-locals,too-many-branches,too-many-statements
def form_action(page_url: str, form: Dict[str, Any], index: int) -> Dict[str, Any]:
    """
    Convert a parsed native form into a disabled action description.

    :param page_url: The URL of the page holding the form.
    :param form: The parsed form dictionary.
    :param index: The zero-based index of the form on the page.
    :return: The action dictionary.
    :raises ValueError: If the form uses unsupported features.
    """
    attrs: Dict[str, str] = form["attributes"]
    if not attrs.get("action") or any(k.startswith("on") for k in attrs):
        raise ValueError("Form has no native action or uses inline JavaScript.")
    endpoint: str = public_url(urljoin(page_url, attrs["action"]))
    if origin(endpoint) != origin(page_url):
        raise ValueError("Form submits to a different origin; explicit API description needed.")
    method: str = attrs.get("method", "get").upper()
    encoding: str = attrs.get("enctype", "application/x-www-form-urlencoded").lower()
    if method not in ("GET", "POST") or encoding != "application/x-www-form-urlencoded":
        raise ValueError("Build-time forms support native GET/POST URL-encoded submissions.")
    props: Dict[str, Dict[str, Any]]
    required: List[str]
    options: Dict[str, List[str]]
    props, required, options = {}, [], {}
    current_select: Optional[str] = None
    control: Dict[str, Any]
    for control in form["controls"]:
        tag: str
        a: Dict[str, str]
        tag, a = control["tag"], control["attributes"]
        name: Optional[str]
        kind: str
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
        schema: Dict[str, Any] = {"type": "string", "title": a.get("aria-label", name), "maxLength": 4096}
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
            html: str
            key: str
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
    values: List[str]
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


def resolve_ref(schema: Dict[str, Any], spec: Dict[str, Any], depth: int = 0) -> Dict[str, Any]:
    """
    Resolve a local OpenAPI "$ref" chain.

    :param schema: The schema that may contain a "$ref".
    :param spec: The full OpenAPI specification.
    :param depth: The current recursion depth.
    :return: The resolved schema.
    :raises ValueError: On non-local or too deeply nested references.
    """
    if depth > 8:
        raise ValueError("Recursive OpenAPI references unsupported.")
    if "$ref" not in schema:
        return schema
    ref: str = schema["$ref"]
    if not ref.startswith("#/"):
        raise ValueError("Only local OpenAPI references are supported.")
    value: Any = spec
    part: str
    for part in ref[2:].split("/"):
        value = value[part.replace("~1", "/").replace("~0", "~")]
    return resolve_ref(value, spec, depth + 1)


def scalar_schema(schema: Dict[str, Any], spec: Dict[str, Any]) -> Dict[str, Any]:
    """
    Reduce an OpenAPI scalar schema to the supported subset.

    :param schema: The parameter or field schema.
    :param spec: The full OpenAPI specification.
    :return: The reduced schema.
    :raises ValueError: If the schema is not a supported scalar.
    """
    schema = resolve_ref(schema, spec)
    allowed: Set[str] = {"type", "title", "description", "enum", "minimum", "maximum", "minLength", "maxLength",
                         "format", "default", "example", "deprecated"}
    if schema.get("type") not in ("string", "number", "integer", "boolean") or set(schema) - allowed:
        raise ValueError("Only scalar API parameters and explicit free-form JSON body fields are supported.")
    if schema.get("format") not in (None, "email", "date", "int32", "int64", "float", "double"):
        raise ValueError("Unsupported API parameter format.")
    result: Dict[str, Any] = {k: v for k, v in schema.items() if k not in ("example", "deprecated", "format")}
    if schema.get("format") in ("email", "date"):
        result["format"] = schema["format"]
    return result


# pylint: disable-next=too-many-locals,too-many-branches,too-many-statements
def api_actions(spec: Dict[str, Any], source: str,
                issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Convert supported OpenAPI 3 operations into disabled action descriptions.

    :param spec: The parsed OpenAPI specification.
    :param source: The source path or URL of the specification.
    :param issues: A list that receives one entry per excluded operation.
    :return: The list of action dictionaries.
    :raises ValueError: If the specification is not OpenAPI 3.
    """
    if not str(spec.get("openapi", "")).startswith("3."):
        raise ValueError("Supply an OpenAPI 3 JSON specification.")
    result: List[Dict[str, Any]] = []
    path: str
    item: Dict[str, Any]
    for path, item in spec.get("paths", {}).items():  # pylint: disable=too-many-nested-blocks
        method: str
        op: Dict[str, Any]
        for method, op in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            label: str = f"{method.upper()} {path}"
            try:
                if (op.get("security", spec.get("security")) or SENSITIVE.search(path)
                        or re.search(r"/(?:admin|login|logout|register|payment)(?:/|$)", path, re.I)):
                    raise ValueError("Authenticated or sensitive operation excluded.")
                servers: List[Dict[str, Any]] = op.get("servers", item.get("servers", spec.get("servers", [])))
                if (not servers or "{" in servers[0]["url"] or not path.startswith("/") or path.startswith("//")
                        or "?" in path):
                    raise ValueError("API requires a fixed server URL and path.")
                endpoint: str = public_url(servers[0]["url"].rstrip("/") + path)
                props: Dict[str, Dict[str, Any]]
                required: List[str]
                bindings: List[Dict[str, str]]
                json_fields: List[str]
                props, required, bindings, json_fields = {}, [], [], []
                parameter: Dict[str, Any]
                for parameter in item.get("parameters", []) + op.get("parameters", []):
                    p: Dict[str, Any] = resolve_ref(parameter, spec)
                    name: str = p["name"]
                    if p["in"] not in ("path", "query") or SENSITIVE.search(name):
                        raise ValueError("Header/cookie/credential parameters excluded.")
                    style: str = p.get("style", "simple" if p["in"] == "path" else "form")
                    if name in props or style not in ("simple", "form") or p.get("allowReserved"):
                        raise ValueError("Ambiguous or unsupported parameter encoding.")
                    props[name] = scalar_schema(p["schema"], spec)
                    bindings.append({"name": name, "in": p["in"]})
                    if p.get("required") or p["in"] == "path":
                        required.append(name)
                body: Dict[str, Any] = resolve_ref(op.get("requestBody", {}), spec)
                if body:
                    if method == "get" or set(body.get("content", {})) != {"application/json"}:
                        raise ValueError("Only JSON API request bodies are supported.")
                    schema: Dict[str, Any] = resolve_ref(body["content"]["application/json"]["schema"], spec)
                    body_keys: Set[str]
                    body_keys = {"type", "properties", "required", "additionalProperties", "description", "title"}
                    if schema.get("type") != "object" or not schema.get("properties") or set(schema) - body_keys:
                        raise ValueError("API body needs explicit object properties.")
                    field: Dict[str, Any]
                    for name, field in schema["properties"].items():
                        if name in props or SENSITIVE.search(name):
                            raise ValueError("Conflicting or credential body field.")
                        field = resolve_ref(field, spec)
                        if (field.get("type") == "object" and field.get("additionalProperties") is True
                                and not field.get("properties")
                                and not set(field) - {"type", "additionalProperties", "description", "title"}):
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


# pylint: disable-next=too-many-locals
def cors_probe(action: Dict[str, Any], site_url: str,
               fetcher: Callable[..., Tuple[str, Dict[str, str], int]]) -> Dict[str, Any]:
    """
    Probe whether the browser may call an action's URLs from the publishing site via CORS preflight.

    :param action: The action dictionary.
    :param site_url: The publishing site URL, or an empty string when unknown.
    :param fetcher: The fetch callable, with the signature of fetch().
    :return: A dictionary with the per-URL checks and a note.
    """
    request: Dict[str, Any] = action["request"]
    urls: List[str] = [request["url"]] + ([request["page"]] if request["kind"] == "form" else [])
    checks: List[Dict[str, Any]] = []
    i: int
    url: str
    for i, url in enumerate(urls):
        if not site_url:
            checks.append({"url": url, "status": "unverified", "reason": "No --site-url provided."})
            continue
        if origin(url) == origin(site_url):
            checks.append({"url": url, "status": "same-origin"})
            continue
        method: str = request["method"] if i == 0 else "GET"
        headers: Dict[str, str] = {"Origin": origin(site_url), "Access-Control-Request-Method": method}
        if request.get("body") and i == 0:
            headers["Access-Control-Request-Headers"] = "content-type"
        try:
            response: Dict[str, str]
            status: int
            _, response, status = fetcher(re.sub(r"\{[^}]+\}", "nsdeploy-probe", url), "OPTIONS", headers)
            response = {k.lower(): v for k, v in response.items()}
            allow: bool = response.get("access-control-allow-origin") in ("*", origin(site_url))
            methods: Set[str]
            methods = {x.strip().upper() for x in response.get("access-control-allow-methods", "").split(",")}
            allowed_headers: Set[str]
            allowed_headers = {x.strip().lower() for x in response.get("access-control-allow-headers", "").split(",")}
            preflight: bool = (200 <= status < 300 and allow and (method in methods or "*" in methods)
                               and ("Access-Control-Request-Headers" not in headers
                                    or bool(allowed_headers & {"*", "content-type"})))
            checks.append({"url": url, "status": "preflight-permitted" if preflight else "unverified",
                           "httpStatus": status})
        except (ValueError, OSError) as exc:
            checks.append({"url": url, "status": "unverified", "reason": str(exc)})
    return {"checks": checks,
            "note": "OPTIONS only; actual browser execution and response CORS remain unverified. "
                    "No business operation was run."}


# pylint: disable-next=too-many-locals,too-many-branches
def discover(site: str, spec_path: Optional[str] = None, site_url: str = "", max_pages: int = 6,
             fetcher: Callable[..., Tuple[str, Dict[str, str], int]] = fetch) -> Dict[str, Any]:
    """
    Discover native forms and OpenAPI operations reachable from a site.

    :param site: The public start URL.
    :param spec_path: Optional OpenAPI JSON path or URL.
    :param site_url: The publishing site URL used for CORS probes.
    :param max_pages: The maximum number of pages to visit (1-20).
    :param fetcher: The fetch callable, with the signature of fetch().
    :return: The discovery lock document.
    :raises ValueError: On invalid arguments or more than 100 operations.
    """
    public_url(site)
    if not 1 <= max_pages <= 20:
        raise ValueError("--action-max-pages must be between 1 and 20.")
    actions: List[Dict[str, Any]]
    issues: List[Dict[str, Any]]
    visited: List[str]
    queue: List[str]
    actions, issues, visited, queue = [], [], [], [site]
    if spec_path:
        if str(spec_path).startswith(("https://", "http://")):
            raw: str = fetcher(spec_path)[0]
        else:
            raw = Path(spec_path).read_text(encoding="utf-8")
        actions += api_actions(json.loads(raw), str(spec_path), issues)
    while queue and len(visited) < max_pages:
        url: str = queue.pop(0)
        if url in visited:
            continue
        visited.append(url)
        try:
            raw, _, _ = fetcher(url)
            if raw.lstrip().startswith("{"):
                actions += api_actions(json.loads(raw), url, issues)
                continue
            page: Page = Page(raw)
            index: int
            form: Dict[str, Any]
            for index, form in enumerate(page.forms):
                try:
                    actions.append(form_action(url, form, index))
                except (ValueError, KeyError) as exc:
                    issues.append({"source": url, "form": index + 1, "reason": str(exc)})
            if page.scripts:
                issues.append({"source": url, "reason": "Page JavaScript was not executed. JS-only actions require "
                                                        "a documented API or site-owned adapter."})
            href: str
            for href in page.links:
                target: SplitResult = urlsplit(urljoin(url, href))
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
    action: Dict[str, Any]
    for action in actions:
        action["cors"] = cors_probe(action, site_url, fetcher)
    return {"version": 1, "source": site, "spec": str(spec_path) if spec_path else None,
            "siteOrigin": origin(site_url) if site_url else None, "visited": visited,
            "actions": actions, "issues": issues}


# pylint: disable-next=too-many-arguments,too-many-positional-arguments
def prepare_actions(lock_path: Union[str, Path], site: Optional[str] = None, spec: Optional[str] = None,
                    site_url: str = "", refresh: bool = False, include_all: bool = False,
                    allow: Sequence[str] = (), max_pages: int = 6) -> Dict[str, Any]:
    """
    Load or (re)discover the action lock, apply enablement choices and write it back.

    :param lock_path: The path of the discovered-actions lock file.
    :param site: The public start URL for discovery.
    :param spec: Optional OpenAPI JSON path or URL.
    :param site_url: The publishing site URL used for CORS probes.
    :param refresh: Whether to rediscover even if a lock file exists.
    :param include_all: Whether to enable every discovered action.
    :param allow: Names of actions to enable.
    :param max_pages: The maximum number of pages to visit during discovery.
    :return: The lock document.
    :raises ValueError: On an invalid lock, changed source, unknown names, or no enabled actions.
    """
    lock_path = Path(lock_path)
    if lock_path.exists() and not refresh:
        doc: Dict[str, Any] = json.loads(lock_path.read_text(encoding="utf-8"))
        if doc.get("version") != 1 or not isinstance(doc.get("actions"), list):
            raise ValueError("Invalid discovered-actions lock file.")
        if (site and site != doc.get("source")) or (spec and str(spec) != doc.get("spec")):
            raise ValueError("Action source changed; use --action-refresh to rediscover and review.")
    else:
        if not site:
            raise ValueError("--action-site is required for initial discovery or refresh.")
        doc = discover(site, spec, site_url, max_pages)
    unknown: Set[str] = set(allow) - {a["name"] for a in doc["actions"]}
    if unknown:
        raise ValueError("Unknown --action-allow names: " + ", ".join(sorted(unknown)))
    action: Dict[str, Any]
    for action in doc["actions"]:
        if include_all or action["name"] in allow:
            action["enabled"] = True
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    count: int = sum(a.get("enabled") is True for a in doc["actions"])
    print(f"   discovered actions: {count}/{len(doc['actions'])} enabled; review {lock_path}")
    issue: Dict[str, Any]
    for issue in doc["issues"]:
        print(f"   discovery note: {issue['source']}: {issue['reason']}")
    if not count:
        raise ValueError(f"No discovered actions enabled. Review {lock_path}, set selected enabled fields to true, "
                         "or use --action-allow NAME. --action-include-all enables all supported candidates "
                         "for a test site.")
    if doc.get("siteOrigin") != (origin(site_url) if site_url else None):
        print("   WARNING: publishing origin differs from the discovery checks; browser CORS needs verification.")
    return doc
