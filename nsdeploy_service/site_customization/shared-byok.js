/* nsdeploy_service shared BYOK cookie: begin */
{
  const cookieName = "__Secure-nsdeploy_shared_byok_v1";
  const maxAgeSeconds = 48 * 60 * 60;

  // Production network sites share a hostname and differ only by port. Cookies
  // ignore ports, so this host-only cookie follows the same browser to each site.
  // HTTPS is mandatory because the cookie contains the caller's own API key.
  if (location.protocol === "https:") {
    const readSharedKey = () => {
      const prefix = `${cookieName}=`;
      const part = document.cookie.split("; ").find((item) => item.startsWith(prefix));
      if (!part) return "";
      try { return decodeURIComponent(part.slice(prefix.length)); } catch { return ""; }
    };
    const writeSharedKey = (key) => {
      document.cookie = `${cookieName}=${encodeURIComponent(key)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Strict; Secure`;
    };
    const clearSharedKey = () => {
      document.cookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict; Secure`;
    };

    const keyInput = document.querySelector("#ns-key");
    const applyButton = document.querySelector("#ns-apply");
    const sharedKey = readSharedKey();
    let sessionKey = "";
    try { sessionKey = sessionStorage.getItem("nsweb-byok-key") || ""; } catch {}

    if (sharedKey && sharedKey !== sessionKey) {
      // boot() has already created this page's engine. Seed the storage it reads
      // and reload once so the engine selects /byok/v1 with the shared key.
      try { sessionStorage.setItem("nsweb-byok-key", sharedKey); } catch {}
      if (keyInput) keyInput.value = sharedKey;
      location.reload();
    } else if (sharedKey && keyInput && !keyInput.value) {
      keyInput.value = sharedKey;
    }

    // nsdeploy's own handler saves the site-local session/profile and reloads.
    // This listener adds only the 48-hour cross-port copy and adds no UI text.
    applyButton?.addEventListener("click", () => {
      const key = keyInput?.value.trim() || "";
      if (key) writeSharedKey(key);
      else clearSharedKey();
    });
  }
}
/* nsdeploy_service shared BYOK cookie: end */
