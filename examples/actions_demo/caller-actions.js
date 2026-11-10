export function registerActions(actions) {
  actions.register({
    name: "save_preferences",
    description: "Save a seating preference in this browser (demonstration).",
    inputSchema: { type: "object", properties: {
      seat: { type: "string", title: "Seating preference", enum: ["inside", "outside", "either"] },
    }, required: ["seat"] },
    effect: "write", availability: "local-only",
    async execute({ seat }) {
      localStorage.setItem("nsdeploy-demo-seat", seat);
      return { saved: true, seat, demo: true };
    },
  });
}
