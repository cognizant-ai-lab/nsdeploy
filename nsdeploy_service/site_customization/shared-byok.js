/* nsdeploy_service shared BYOK cookie: begin */
{
  // The service fills this in with its public host when sites are served on
  // subdomains of it, so one cookie reaches every site under that host. It stays
  // empty when sites share one hostname and differ only by port, because cookies
  // ignore ports and a host-only cookie already follows the browser to each site.
  const cookieDomain = "";
  const maxAgeSeconds = 48 * 60 * 60;
  const host = location.hostname;
  const secure = location.protocol === "https:";
  // The cookie holds the caller's own API key, so plain http is only allowed on
  // this machine, where the request never leaves it.
  const loopback = host === "localhost" || host.endsWith(".localhost")
    || host === "127.0.0.1" || host === "[::1]";

  if (secure || loopback) {
    // The __Secure- prefix needs the Secure attribute, which some browsers refuse
    // over http even on localhost, so local http uses a plain name.
    const cookieName = secure ? "__Secure-nsdeploy_shared_byok_v1" : "nsdeploy_shared_byok_v1";
    const attrs = `Path=/; Max-Age=${maxAgeSeconds}; SameSite=Strict${secure ? "; Secure" : ""}`;
    const clearAttrs = `Path=/; Max-Age=0; SameSite=Strict${secure ? "; Secure" : ""}`;
    // Only use the domain when this page is on it, so a mis-set host cannot send
    // the key somewhere else.
    const domain = cookieDomain && (host === cookieDomain || host.endsWith(`.${cookieDomain}`))
      ? cookieDomain : "";

    const readSharedKeys = () => {
      const prefix = `${cookieName}=`;
      return document.cookie.split("; ")
        .filter((item) => item.startsWith(prefix))
        .map((item) => {
          try { return decodeURIComponent(item.slice(prefix.length)); } catch { return ""; }
        })
        .filter(Boolean);
    };
    const clearHostOnly = () => { document.cookie = `${cookieName}=; ${clearAttrs}`; };
    const writeSharedKey = (key) => {
      const value = `${cookieName}=${encodeURIComponent(key)}`;
      if (domain) {
        document.cookie = `${value}; ${attrs}; Domain=${domain}`;
        // A browser refuses a domain it treats as public, such as localhost in
        // some browsers. Keep a host-only copy then, so this site still has it.
        if (readSharedKeys().includes(key)) return;
      }
      document.cookie = `${value}; ${attrs}`;
    };
    const clearSharedKey = () => {
      if (domain) document.cookie = `${cookieName}=; ${clearAttrs}; Domain=${domain}`;
      clearHostOnly();
    };

    let sharedKey = readSharedKeys()[0] || "";
    if (domain && sharedKey) {
      // A key saved before the domain was set is host-only and would hide the
      // shared one on this site. Move it to the domain cookie.
      clearHostOnly();
      if (!readSharedKeys().length) writeSharedKey(sharedKey);
      sharedKey = readSharedKeys()[0] || "";
    }

    const keyInput = document.querySelector("#ns-key");
    const applyButton = document.querySelector("#ns-apply");
    let sessionKey = "";
    // nsdeploy marks a setup applied in this tab with this item, even when its key
    // is empty. That setup keeps its own key, so the shared key must not replace it
    // or fill the key field.
    let tabSetupApplied = false;
    try {
      sessionKey = sessionStorage.getItem("nsweb-byok-key") || "";
      tabSetupApplied = sessionStorage.getItem("nsweb-byok-router") !== null;
    } catch {}

    if (sharedKey && !tabSetupApplied && sharedKey !== sessionKey) {
      // boot() has already created this page's engine. Seed the storage it reads
      // and reload once so the engine selects /byok/v1 with the shared key.
      try { sessionStorage.setItem("nsweb-byok-key", sharedKey); } catch {}
      if (keyInput) keyInput.value = sharedKey;
      location.reload();
    } else if (sharedKey && !tabSetupApplied && keyInput && !keyInput.value) {
      keyInput.value = sharedKey;
    }

    // nsdeploy's own handler saves the site-local session/profile and reloads.
    // This listener adds only the 48-hour shared copy and adds no UI text.
    applyButton?.addEventListener("click", () => {
      const key = keyInput?.value.trim() || "";
      if (key) writeSharedKey(key);
      else clearSharedKey();
    });
  }
}
/* nsdeploy_service shared BYOK cookie: end */
