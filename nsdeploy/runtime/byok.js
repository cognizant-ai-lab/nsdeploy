// byok.js - persistent browser-side BYOK profile storage.
//
// Keys never go in URLs. Profiles are stored in localStorage, and on loopback
// hosts only we mirror them to a host cookie so settings follow nsDeploy across
// localhost/127.0.0.1 ports. Do not enable cookie mirroring for non-local hosts:
// cookies are sent to the serving host on every request.

import { normalizeModelName } from "./model.js";

const STORE_KEY = "nsweb-byok-profiles-v1";
const COOKIE_NAME = "nsweb_byok_profiles_v1";
const VERSION = 1;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
const COOKIE_VALUE_LIMIT = 3800;
const MAX_PROFILES = 12;

const emptyStore = () => ({ version: VERSION, selectedId: "", updatedAt: "", profiles: [] });

export function loadByokStore() {
  const local = readLocalStore();
  const cookie = readCookieStore();
  return newerStore(local, cookie) || emptyStore();
}

export function getSelectedByokProfile(store = loadByokStore()) {
  if (!store.selectedId) return null;
  return store.profiles.find((p) => p.id === store.selectedId) || null;
}

export function upsertByokProfile(profile, { select = true } = {}) {
  const store = loadByokStore();
  const now = new Date().toISOString();
  const id = profile.id || newProfileId();
  const existing = store.profiles.find((p) => p.id === id) || {};
  const next = normalizeProfile({ ...existing, ...profile, id, updatedAt: now });
  if (!next) return { store, profile: null };

  const profiles = [next, ...store.profiles.filter((p) => p.id !== id)]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, MAX_PROFILES);
  const nextStore = {
    version: VERSION,
    selectedId: select ? id : store.selectedId,
    updatedAt: now,
    profiles,
  };
  saveByokStore(nextStore);
  return { store: nextStore, profile: next };
}

export function deleteByokProfile(id) {
  const store = loadByokStore();
  const profiles = store.profiles.filter((p) => p.id !== id);
  const nextStore = {
    version: VERSION,
    selectedId: store.selectedId === id ? (profiles[0]?.id || "") : store.selectedId,
    updatedAt: new Date().toISOString(),
    profiles,
  };
  saveByokStore(nextStore);
  return nextStore;
}

export function selectByokProfile(id) {
  const store = loadByokStore();
  const selectedId = store.profiles.some((p) => p.id === id) ? id : "";
  const nextStore = { ...store, selectedId, updatedAt: new Date().toISOString() };
  saveByokStore(nextStore);
  return nextStore;
}

export function guessByokProfileName({ router, model } = {}) {
  const hay = `${router || ""} ${model || ""}`.toLowerCase();
  if (/localhost|127\.0\.0\.1|\[::1\]|:11434|:12434|ollama|docker/.test(hay)) return "Local LLM";
  if (/anthropic|claude/.test(hay)) return "Anthropic";
  if (/openrouter/.test(hay)) return "OpenRouter";
  if (/openai|gpt-/.test(hay)) return "OpenAI";
  return model || "LLM setup";
}

export function resolveByokRouter(router) {
  const value = String(router || "").trim();
  if (!value) return "";
  if (value.startsWith("/") && typeof location !== "undefined") {
    try { return new URL(value, location.origin).toString().replace(/\/$/, ""); } catch {}
  }
  return value;
}

export function portableByokRouter(router) {
  const value = String(router || "").trim();
  if (!value || typeof location === "undefined") return value;
  try {
    const url = new URL(value, location.origin);
    const path = url.pathname.replace(/\/$/, "");
    if (url.origin === location.origin && path === "/byok/v1") {
      return "/byok/v1";
    }
  } catch {}
  return value;
}

export function canUseByokCookie() {
  if (typeof location === "undefined") return false;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function saveByokStore(store) {
  const normalized = normalizeStore(store);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(normalized)); } catch {}
  writeCookieStore(normalized);
}

function readLocalStore() {
  try { return normalizeStore(JSON.parse(localStorage.getItem(STORE_KEY) || "null")); } catch { return null; }
}

function readCookieStore() {
  if (!canUseByokCookie() || typeof document === "undefined") return null;
  const prefix = `${COOKIE_NAME}=`;
  const part = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  if (!part) return null;
  try { return normalizeStore(JSON.parse(decodeURIComponent(part.slice(prefix.length)))); } catch { return null; }
}

function writeCookieStore(store) {
  if (!canUseByokCookie() || typeof document === "undefined") return;
  const value = encodeURIComponent(JSON.stringify(store));
  const attrs = `Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  if (value.length <= COOKIE_VALUE_LIMIT) {
    document.cookie = `${COOKIE_NAME}=${value}; ${attrs}`;
  } else {
    document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

function newerStore(a, b) {
  if (!a) return b;
  if (!b) return a;
  return String(b.updatedAt || "") > String(a.updatedAt || "") ? b : a;
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== "object") return null;
  const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
    .map(normalizeProfile)
    .filter(Boolean)
    .slice(0, MAX_PROFILES);
  const selectedId = profiles.some((p) => p.id === raw.selectedId) ? String(raw.selectedId) : "";
  return {
    version: VERSION,
    selectedId,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    profiles,
  };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim() || newProfileId();
  const key = String(raw.key || "");
  const model = normalizeModelName(raw.model);
  const router = String(raw.router || "").trim();
  const runner = !!raw.runner;
  const name = String(raw.name || guessByokProfileName({ router, model })).trim().slice(0, 80);
  if (!key && !model && !router) return null;
  return {
    id,
    name: name || "LLM setup",
    key,
    model,
    router,
    runner,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function newProfileId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
