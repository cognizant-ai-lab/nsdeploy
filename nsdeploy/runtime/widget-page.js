import { boot } from "./index.js";

/** Boot the compact static agent surface inside its own document. */
class WidgetPage {
  /** Start the ordinary runtime and expose loading failures in the frame. */
  static async start() {
    try {
      await boot("#app", { originUrl: new URL("../", import.meta.url).href,
        sandboxWorkerUrl: new URL("./sandbox-worker.js", import.meta.url).href });
      document.addEventListener("keydown", WidgetPage.keydown);
    } catch (error) {
      document.querySelector("#app").textContent = `Agent could not load: ${error.message}`;
      console.error(error);
    }
  }

  /** Let Escape inside the frame close its containing widget. */
  static keydown(event) {
    if (event.key === "Escape" && parent !== window) {
      parent.postMessage("nsdeploy:close", location.origin);
    }
  }
}

await WidgetPage.start();
