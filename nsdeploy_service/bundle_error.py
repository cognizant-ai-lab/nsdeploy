class BundleError(RuntimeError):
    """A static bundle build which cannot continue, reported to the client as a 400.

    Raised only for a request the caller can correct: an empty or oversized HOCON, a
    name that is not a plain identifier, a network with no front man, or a HOCON the
    resolver refuses. A fault of the service itself is left to propagate, so that a
    broken service does not read as a bad request.
    """
