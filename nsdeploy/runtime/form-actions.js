// Discover the native HTML contract of site-owner-selected pages. No page scripts
// execute during discovery. JavaScript-only forms need a registered site module.
import { validateData } from "./actions.js";

const secret = /password|passwd|secret|token|csrf|authorization|cookie|credit.?card|card.?number|cvv|cvc|otp/i;
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const controls = form => [...form.elements].filter(e => e.name && !e.matches(":disabled"));
const label = e => (e.getAttribute("aria-label") || [...(e.labels || [])].map(l => l.textContent).join(" ") || e.name || "").trim().slice(0, 200);
const hash = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); };

function ownUrl(path, base) {
  const url = new URL(path, base);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) throw new Error("Form pages and endpoints must be on the owning origin.");
  url.hash = "";
  return url;
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Form page/response exceeds 1 MB.");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

async function pageDocument(url, signal) {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) throw new Error("Form page unavailable or not HTML; sign in on the owning site if needed.");
  const doc = new DOMParser().parseFromString(await boundedText(response), "text/html");
  const base = ownUrl(doc.querySelector("base[href]")?.getAttribute("href") || url, url);
  return { doc, base };
}

function describe(form, pageUrl, base, index, submitIndex) {
  if (form.hasAttribute("data-nsdeploy-ignore")) throw new Error("Excluded by site owner.");
  const all = controls(form);
  if (form.hasAttribute("onsubmit") || [...form.elements].some(e => [...e.attributes].some(a => /^on/i.test(a.name)))) throw new Error("Inline JavaScript form requires a registered module.");
  if (all.some(e => ["password", "file", "image"].includes(e.type) || /cc-|one-time-code|password/.test(e.autocomplete || ""))) throw new Error("Sensitive/file controls require the site's own UI.");
  const submitters = [...form.elements].filter(e => e.type === "submit" && !e.matches(":disabled"));
  const submitter = submitters[submitIndex];
  const attr = name => submitter?.getAttribute(`form${name}`) ?? form.getAttribute(name);
  if (!attr("action")) throw new Error("No explicit native action; JavaScript-only forms require a registered module.");
  const endpoint = ownUrl(attr("action"), base).href;
  const method = (attr("method") || "get").toUpperCase();
  const enctype = (attr("enctype") || "application/x-www-form-urlencoded").toLowerCase();
  if (!["GET", "POST"].includes(method) || !["application/x-www-form-urlencoded", "multipart/form-data"].includes(enctype)) throw new Error("Unsupported native form method/encoding.");
  const fields = new Map();
  for (const e of all) {
    if (["hidden", "submit", "button", "reset"].includes(e.type) || e.readOnly) continue;
    if (secret.test(e.name) || unsafe.has(e.name)) throw new Error("Sensitive or unsafe field name requires the site's own UI.");
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(e.tagName)) throw new Error("Custom controls require a registered module.");
    if (!fields.has(e.name)) fields.set(e.name, []);
    fields.get(e.name).push(e);
  }
  const properties = Object.create(null), required = [];
  for (const [name, group] of fields) {
    const e = group[0];
    let s = { type: "string", title: label(e) };
    if (group.every(c => c.type === "radio")) s.enum = group.map(c => c.value);
    else if (group.every(c => c.type === "checkbox")) {
      s = group.length === 1 ? { ...s, type: "boolean" }
        : { ...s, type: "array", items: { type: "string", enum: group.map(c => c.value) } };
    } else if (group.length > 1) throw new Error("Repeated non-choice field names require a registered module.");
    else if (e.tagName === "SELECT") {
      const values = [...e.options].filter(o => !o.disabled && !o.parentElement?.disabled).map(o => o.value);
      if (!values.length) throw new Error("Empty select requires application data.");
      s = e.multiple ? { ...s, type: "array", items: { type: "string", enum: values } } : { ...s, enum: values };
    } else if (e.type === "number" || e.type === "range") {
      s.type = "number";
      for (const [attr, key] of [["min", "minimum"], ["max", "maximum"]]) if (e.getAttribute(attr) && Number.isFinite(Number(e.getAttribute(attr)))) s[key] = Number(e.getAttribute(attr));
    } else {
      if (["date", "email"].includes(e.type)) s.format = e.type;
      for (const [attr, key] of [["minlength", "minLength"], ["maxlength", "maxLength"]]) if (e.hasAttribute(attr)) s[key] = Number(e.getAttribute(attr));
    }
    properties[name] = s;
    if (group.some(c => c.required)) required.push(name);
  }
  const inputSchema = { type: "object", properties, required };
  if (all.some(e => (e.type === "hidden" || e.readOnly) && fields.has(e.name))) throw new Error("Hidden/fixed fields overlap editable fields; use a registered module.");
  const effect = form.getAttribute("data-nsdeploy-effect") === "read" ? "read" : "write";
  const identity = `${pageUrl}|${form.id || index}|${submitIndex}`;
  const name = `form_${hash(identity)}`;
  const title = form.getAttribute("aria-label") || form.getAttribute("name") || form.id || submitter?.textContent || submitter?.value || `Form ${index + 1}`;
  const description = `${title.trim().slice(0, 200)}: ${method} ${new URL(endpoint).pathname}. Native form on ${new URL(pageUrl).pathname}. Returns a server response; business success must be verified from its content.`;
  // Tokens may refresh; other hidden values (e.g. the record being cancelled)
  // must stay pinned so refreshing cannot silently change the approved target.
  const signature = JSON.stringify({ endpoint, method, enctype, inputSchema, effect,
    hidden: all.filter(e => e.type === "hidden").map(e => [e.name, secret.test(e.name) ? null : e.value]),
    fixed: all.filter(e => e.readOnly).map(e => [e.name, e.value]),
    submit: submitter ? [submitter.name, submitter.value] : null });
  return { name, description, inputSchema, effect, signature, endpoint, method, enctype, form, fields, submitter };
}

function fill(def, args) {
  validateData(def.inputSchema, args);
  for (const [name, group] of def.fields) {
    const value = args[name];
    for (const e of group) {
      if (e.type === "checkbox") e.checked = group.length === 1 ? value === true : (value || []).includes(e.value);
      else if (e.type === "radio") e.checked = value === e.value;
      else if (e.tagName === "SELECT" && e.multiple) for (const o of e.options) o.selected = (value || []).includes(o.value);
      else e.value = value == null ? "" : String(value);
    }
  }
  // Includes pattern, step, date bounds, required checkbox groups, etc. that the
  // CRUSE schema subset cannot express. Detached forms still validate natively.
  if (!HTMLFormElement.prototype.checkValidity.call(def.form)) throw new Error("The website's native form validation rejected these values. Nothing was submitted.");
}

function responseEvidence(text, contentType, hiddenValues) {
  const redact = value => {
    let result = value;
    for (const v of hiddenValues) if (v.length >= 4) result = result.split(v).join("[redacted]");
    return result;
  };
  if (contentType.includes("json")) {
    const data = JSON.parse(text, (key, value) => secret.test(key) || unsafe.has(key) ? undefined : value);
    return { format: "json", text: redact(JSON.stringify(data)).slice(0, 12000) };
  }
  const doc = new DOMParser().parseFromString(text, "text/html");
  doc.querySelectorAll("script,style,template,form,input,textarea,select,[hidden]").forEach(e => e.remove());
  return { format: "text", text: redact(doc.body.textContent.replace(/\s+/g, " ").trim()).slice(0, 12000) };
}

export async function registerFormActions(actions, { pages = [], callerOrigins = [], base = location.href, report = () => {} } = {}) {
  let count = 0;
  for (const path of pages) {
    const url = ownUrl(path, base).href;
    try {
      const source = await pageDocument(url, AbortSignal.timeout(15000));
      const forms = [...source.doc.forms];
      if (!forms.length) report({ page: path, reason: "No native forms found. Client-rendered/JavaScript-only pages need a registered module." });
      for (let index = 0; index < forms.length; index++) {
        const n = Math.max(1, [...forms[index].elements].filter(e => e.type === "submit" && !e.matches(":disabled")).length);
        for (let submitIndex = 0; submitIndex < n; submitIndex++) {
          try {
            const def = describe(forms[index], url, source.base, index, submitIndex);
            actions.register({ name: def.name, description: def.description, inputSchema: def.inputSchema,
              effect: def.effect, availability: "bridge", callerOrigins,
              async execute(args, { signal }) {
                const fresh = await pageDocument(url, signal || AbortSignal.timeout(15000));
                const form = def.form.id ? fresh.doc.getElementById(def.form.id) : fresh.doc.forms[index];
                if (!form || form.tagName !== "FORM") throw new Error("Form disappeared; refresh the agent page.");
                const current = describe(form, url, fresh.base, index, submitIndex);
                if (current.signature !== def.signature) throw new Error("Form changed since review; refresh the agent page. Nothing was submitted.");
                fill(current, args);
                const data = new FormData(form, current.submitter);
                const endpoint = new URL(current.endpoint);
                const options = { method: current.method, credentials: "same-origin", redirect: "error", signal };
                if (current.method === "GET") endpoint.search = new URLSearchParams(data).toString();
                else options.body = current.enctype === "multipart/form-data" ? data : new URLSearchParams(data);
                const response = await fetch(endpoint, options);
                if (!response.ok) throw new Error(`Website returned HTTP ${response.status}; check the site before retrying.`);
                const evidence = responseEvidence(await boundedText(response), response.headers.get("content-type") || "",
                  controls(form).filter(e => e.type === "hidden" || e.readOnly).map(e => e.value));
                return { outcome: "response_received", businessOutcome: "unverified", httpStatus: response.status, evidence };
              }
            });
            count++;
          } catch (error) { report({ page: path, form: index + 1, reason: error.message }); }
        }
      }
    } catch (error) { report({ page: path, reason: error.message }); }
  }
  return count;
}
