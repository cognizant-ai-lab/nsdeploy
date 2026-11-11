/* nsdeploy_service shared BYOK cookie: begin */
{
  const maxAgeSeconds = 48 * 60 * 60;
  // When sites are on subdomains, the service fills in its public host here so one
  // cookie reaches every site. Sites on one hostname with different ports need no
  // domain, because cookies ignore ports.
  const cookieDomain = "";
  const secure = location.protocol === "https:";
  const host = location.hostname;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");

  // The cookie contains the caller's own API key, so plain http is only allowed on
  // this machine.
  if (secure || loopback) {
    // The __Secure- prefix needs https.
    const cookieName = secure ? "__Secure-nsdeploy_shared_byok_v1" : "nsdeploy_shared_byok_v1";
    const attrs = `Path=/${cookieDomain ? `; Domain=${cookieDomain}` : ""}; SameSite=Strict${secure ? "; Secure" : ""}`;
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
    if (cookieDomain) document.cookie = `${cookieName}=; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;

    const keyInput = document.querySelector("#ns-key");
    const applyButton = document.querySelector("#ns-apply");
    const sharedKey = readSharedKey();
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
