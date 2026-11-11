/* nsdeploy_service shared BYOK cookie: begin */
{
  const cookieName = "__Secure-nsdeploy_shared_byok_v1";
  const maxAgeSeconds = 48 * 60 * 60;
  // Sites on one hostname differ only by port, and cookies ignore ports, so a
  // host-only cookie follows the browser to each site. Sites on subdomains need the
  // cookie on their shared domain, which the service fills in here.
  const cookieDomain = "";

  // The cookie contains the caller's own API key, so it is only used over https or
  // on localhost, which browsers treat as secure.
  if (window.isSecureContext) {
    const attrs = `Path=/${cookieDomain ? `; Domain=${cookieDomain}` : ""}; SameSite=Strict; Secure`;
    const readSharedKey = () => {
      const prefix = `${cookieName}=`;
      const part = document.cookie.split("; ").find((item) => item.startsWith(prefix));
      if (!part) return "";
      try { return decodeURIComponent(part.slice(prefix.length)); } catch { return ""; }
    };
    const writeSharedKey = (key) => {
      document.cookie = `${cookieName}=${encodeURIComponent(key)}; ${attrs}; Max-Age=${maxAgeSeconds}`;
    };
    const clearSharedKey = () => {
      document.cookie = `${cookieName}=; ${attrs}; Max-Age=0`;
    };

    // A copy saved for this site alone, from before sites shared one, would hide
    // the shared key, so remove it.
    if (cookieDomain) document.cookie = `${cookieName}=; Path=/; Max-Age=0; Secure`;

    // Every site's own relay sends a key to the same service upstream. A key applied
    // with any other Provider URL is for that provider only, and another site would
    // send it to its relay instead, so it is never shared. Only the hostname is
    // compared: every port on it is this service, and a relay URL has no port when
    // the service is reached through a proxy port.
    const usesSiteRelay = (router) => {
      if (!router) return true;
      try {
        const url = new URL(router, location.href);
        return url.hostname === location.hostname && url.pathname.replace(/\/$/, "") === "/byok/v1";
      } catch { return false; }
    };

    const keyInput = document.querySelector("#ns-key");
    const applyButton = document.querySelector("#ns-apply");
    const clickedItem = "nsdeploy-shared-byok-clicked";
    let clickedKey = null;
    let tabKey = "";
    let tabRouter = null;
    let sessionKey = "";
    try {
      clickedKey = sessionStorage.getItem(clickedItem);
      sessionStorage.removeItem(clickedItem);
      tabKey = sessionStorage.getItem("nsweb-byok-tab-key") || "";
      // nsdeploy marks a setup applied in this tab with this item, even when its
      // key is empty.
      tabRouter = sessionStorage.getItem("nsweb-byok-router");
      sessionKey = sessionStorage.getItem("nsweb-byok-key") || "";
    } catch {}
    const tabSetupApplied = tabRouter !== null;

    // nsdeploy saves a setup and reloads only when it passes the page's checks. So
    // the key clicked before this load is shared only if this tab now has it.
    if (clickedKey !== null && tabSetupApplied && clickedKey === tabKey) {
      if (!tabKey) clearSharedKey();
      else if (usesSiteRelay(tabRouter)) writeSharedKey(tabKey);
    }

    // A setup applied in this tab keeps its own key, so the shared key must not
    // replace it or fill the key field.
    const sharedKey = readSharedKey();
    if (sharedKey && !tabSetupApplied && sharedKey !== sessionKey) {
      // boot() has already created this page's engine. Seed the storage it reads
      // and reload once so the engine selects /byok/v1 with the shared key.
      try { sessionStorage.setItem("nsweb-byok-key", sharedKey); } catch {}
      if (keyInput) keyInput.value = sharedKey;
      location.reload();
    } else if (sharedKey && !tabSetupApplied && keyInput && !keyInput.value) {
      keyInput.value = sharedKey;
    }

    // nsdeploy's own handler checks and saves the setup, then reloads. This listener
    // only notes the key, so the next load can share it, and adds no UI text.
    applyButton?.addEventListener("click", () => {
      try { sessionStorage.setItem(clickedItem, keyInput?.value.trim() || ""); } catch {}
    });
    // Deleting a setup means the visitor wants their key gone, so the other sites
    // stop getting it too.
    document.querySelector("#ns-delete-profile")?.addEventListener("click", clearSharedKey);
  }
}
/* nsdeploy_service shared BYOK cookie: end */
