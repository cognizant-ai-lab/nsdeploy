export function registerActions(actions) {
  actions.register({
    name: "reserve_table",
    description: "Submit a demonstration reservation request. Does not make a real booking.",
    inputSchema: { type: "object", properties: {
      date: { type: "string", format: "date", title: "Visit date" },
      partySize: { type: "integer", minimum: 1, maximum: 12, title: "Guests" },
    }, required: ["date", "partySize"] },
    effect: "write", availability: "bridge",
    callerOrigins: ["http://127.0.0.1:8121"],
    async execute(values, { requestId, signal }) {
      const response = await fetch(new URL("./api/reservations", import.meta.url), {
        method: "POST", credentials: "same-origin", signal,
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error(`Reservation request failed: ${response.status}`);
      return response.json();
    },
  });
}
