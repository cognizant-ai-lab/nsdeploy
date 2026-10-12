"""Trusted Seabreeze fixture policy for the vendored arbiter (USD cents).

This module is server code, never a browser asset or an agent tool response.
The buyer ceiling and seller floor are withheld from the opposite party.
"""
from datetime import date, timedelta

PROVIDERS = CONNECTED = ("seabreeze_inn",)
RETAIL_SCOPE = "Retail transactions are not enabled."
CAVEAT = (
    "Informational, fixed catalogue price; no reservation or payment. "
    "Ask your private steward in nsFlow to negotiate through Cailville Commerce Arbiter."
)
CATALOG = {
    "seabreeze_inn": {
        "item_id": "seabreeze-one-night-stay",
        "title": "Seabreeze Inn · one-night coastal stay for two",
        "list_cents": 52500, "floor_cents": 45500,
        "lodging_cents": 39500, "fees_cents": 8000, "activity_cents": 5000,
        "cancellation": "Demo terms: full refund until 24 hours before arrival; refunds are not implemented.",
    },
}


def providers_for(kind):
    return PROVIDERS if kind == "travel" else ()


def default_trip():
    today = date.today()
    arrival = today + timedelta(days=7 - today.weekday() + 4)
    return {"destination": "Cailville", "arrival": arrival.isoformat(),
            "departure": (arrival + timedelta(days=1)).isoformat(),
            "travelers": 2, "amenities": ["parking", "wifi"]}


def validate_trip(trip):
    if not isinstance(trip, dict) or set(trip) != set(default_trip()):
        raise ValueError("Use only the supported public stay fields.")
    if (trip["destination"] != "Cailville" or type(trip["travelers"]) is not int
            or trip["travelers"] != 2 or trip["amenities"] != ["parking", "wifi"]):
        raise ValueError("This fixture is a Cailville stay for two adults with parking and Wi-Fi.")
    if not all(isinstance(trip[key], str) for key in ("arrival", "departure")):
        raise ValueError("Dates must use YYYY-MM-DD.")
    arrival, departure = date.fromisoformat(trip["arrival"]), date.fromisoformat(trip["departure"])
    if (arrival.isoformat() != trip["arrival"] or departure.isoformat() != trip["departure"]
            or arrival < date.today() or departure - arrival != timedelta(days=1)):
        raise ValueError("Choose exactly one night, arriving today or later.")
    return {**trip, "amenities": list(trip["amenities"])}


def validate_retail_purchase(purchase):
    raise ValueError(RETAIL_SCOPE)


def travel_scope(trip):
    return ("One night for two adults in Cailville, parking, Wi-Fi and one local activity. "
            "Taxes and fees included; meals and travel to Cailville excluded. "
            "Fixture inventory and simulated payment only; no real reservation.")


def travel_item(provider, trip):
    return dict(CATALOG[provider])


def public_catalog(provider, subject, kind="travel"):
    if provider not in PROVIDERS or kind != "travel":
        raise ValueError("Provider is outside this demo's scope.")
    subject = validate_trip(subject)
    item = CATALOG[provider]
    return {"provider": provider, "status": "INFORMATION_ONLY", "simulation": True,
            "item_id": item["item_id"], "title": item["title"], "trip": subject,
            "currency": "USD", "total_cents": item["list_cents"],
            "scope": travel_scope(subject), "cancellation": item["cancellation"], "caveat": CAVEAT}
