"""Derive suggested relations between deployed agent networks from their descriptions.

This is the Cailville idea (`nsdeploy/cailville.py::infer_profile`) generalised for the
deployment registry. Cailville scores a *new* site against a fixed, hand-authored town
of thirteen peers and carries per-site tuning — literal bonuses for
`main_street_exchange`, `harbor_town_hall` and friends, plus a fallback that force-adds
peers when fewer than two score. Neither survives contact with an arbitrary set of
uploaded networks, so the scoring here is rebuilt rather than imported.

Two signals, deliberately kept apart because they mean different things:

* **capability** — the consumer declares an unfilled `link_slot` whose name matches what
  the provider actually does. Directional and grounded in structure: one side states a
  hole, the other looks able to fill it.
* **affinity** — the two networks simply write about the same things. Symmetric, and
  weaker: high affinity between two order-management orchestrators means they are
  *alternatives*, not collaborators. Useful to surface, dangerous to act on.

Term weighting is smoothed inverse document frequency over the deployed set, which
makes the scoring self-tuning: vocabulary every network shares — the injected CRUSE
directive, "agent", "request" — earns almost nothing, while a term unique to two
networks dominates. That is also why this module needs no knowledge of what nsdeploy
injects into instructions.

Everything here is a pure function over plain dicts. It performs no I/O beyond reading
a generated bundle, holds no service imports, and returns dataclasses rather than
response models, so the API layer owns its own schema.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

# A relation is only worth showing if the evidence clears these. Tuned so that two
# networks in the same domain relate, while unrelated ones produce nothing at all.
DEFAULT_MIN_AFFINITY = 0.08
DEFAULT_MIN_SLOT_COVERAGE = 0.5
DEFAULT_MAX_PER_NETWORK = 4

# Longest role/description text considered per agent. Long instructions are mostly
# protocol boilerplate; the opening sentences carry the role.
ROLE_TEXT_LIMIT = 240

MIN_WORD_LENGTH = 3
_WORD_RE = re.compile(r"[a-z0-9]+")
_WHITESPACE_RE = re.compile(r"\s+")

# Generic English plus agent-framework boilerplate. IDF already suppresses terms shared
# by every network, but with only two or three deployed there is not enough corpus for
# that to bite, so the obvious noise is removed outright.
STOP_WORDS = frozenset("""
about above across after again against all also and any are because been before being
below between both but can cannot could did does doing down during each few for from
further had has have having her here hers him his how into its itself may more most
must not now off once only other our ours out over own same she should some such than
that the their theirs them themselves then there these they this those through too
under until use used uses using very was were what when where which while who whom why
will with would you your yours
agent agents answer ask asked call called caller calls cruse data detail details
follow followup handle handles help helpful inquiry input instruction
instructions json mode network networks output request requests require required
requirements respond response responses result results return returns system tool
tools user users widget widgets work working
""".split())


@dataclass(frozen=True)
class AgentRole:
    """One agent inside a deployed network, as far as relation scoring cares."""

    name: str
    role: str = ""


@dataclass(frozen=True)
class NetworkIdentity:
    """The description-level facts about one deployed network.

    Assembled from the persisted deployment record plus its generated bundle — never
    from the uploaded HOCON, which would mean re-resolving (and re-importing) it.
    """

    deployment_id: str
    name: str
    description: str = ""
    front_man: str = ""
    sample_queries: Tuple[str, ...] = ()
    agents: Tuple[AgentRole, ...] = ()
    open_slots: Tuple[str, ...] = ()

    def profile_text(self) -> str:
        """Everything this network says about itself — the affinity signal."""
        parts = [_humanize(self.name), self.description, _humanize(self.front_man)]
        parts.extend(self.sample_queries)
        parts.extend(f"{_humanize(agent.name)} {agent.role}" for agent in self.agents)
        return " ".join(part for part in parts if part)

    def capability_text(self) -> str:
        """What this network can *do* — matched against a consumer's open slots.

        Sample queries are excluded on purpose: they describe what a user might ask,
        not what the network provides, and they are long enough to swamp the signal.
        """
        parts = [_humanize(self.name), self.description, _humanize(self.front_man)]
        parts.extend(f"{_humanize(agent.name)} {agent.role}" for agent in self.agents)
        return " ".join(part for part in parts if part)


@dataclass(frozen=True)
class SuggestedRelation:
    """A proposed, unapplied edge from one deployed network to another.

    Advisory by construction. Nothing in the service turns one of these into a binding:
    an inferred delegation written to a site's links.json would be served to every
    visitor as though a human had chosen it.
    """

    source: str                  # deployment id that would call
    target: str                  # deployment id that would be called
    kind: str                    # "capability" | "affinity"
    score: float
    reason: str
    reference: Optional[str] = None   # the open slot, for a capability relation
    origin: str = "heuristic"         # "heuristic" | "llm"


@dataclass
class Vocabulary:
    """Smoothed inverse document frequency over the deployed networks' own words."""

    document_count: int = 0
    frequencies: Dict[str, int] = field(default_factory=dict)

    def weight(self, term: str) -> float:
        """Rarer terms count for more; a term in every network counts for ~1.0.

        Smoothed so the weight stays positive and usable when only two networks are
        deployed — plain log(N/df) would zero out every shared term at N == 2 and make
        all scores zero.
        """
        frequency = self.frequencies.get(term, 0)
        return math.log((1 + self.document_count) / (1 + frequency)) + 1.0

    def mass(self, terms: Iterable[str]) -> float:
        return sum(self.weight(term) for term in terms)


def _humanize(value: str) -> str:
    """`order_ops_director` -> `order ops director`, so identifiers contribute words."""
    return re.sub(r"[_\-.]+", " ", str(value or ""))


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", str(text or "")).strip()


def tokens(text: str) -> set[str]:
    """Content words in `text`, lowercased, stopped and length-filtered."""
    return {
        word for word in _WORD_RE.findall(str(text or "").lower())
        if len(word) >= MIN_WORD_LENGTH and word not in STOP_WORDS
    }


def build_vocabulary(identities: Sequence[NetworkIdentity]) -> Vocabulary:
    """Count, per term, how many networks use it."""
    vocabulary = Vocabulary(document_count=len(identities))
    for identity in identities:
        for term in tokens(identity.profile_text()):
            vocabulary.frequencies[term] = vocabulary.frequencies.get(term, 0) + 1
    return vocabulary


# --- identity loading --------------------------------------------------------

def _agent_roles(out_dir: Path, name: str) -> Tuple[AgentRole, ...]:
    """Per-agent names and roles from the generated network JSON.

    The stored NetworkSummary keeps only an agent *count*, but the bundle has every
    agent. `function.description` is preferred over `instructions`: instructions carry
    the AAOSA protocol text and the injected CRUSE directive, which are identical
    across networks and say nothing about this one.
    """
    try:
        config = json.loads((out_dir / f"{name}.network.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ()
    roles: List[AgentRole] = []
    for entry in (config.get("tools") or []):
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        if "instructions" not in entry:
            continue  # a coded/toolbox leaf, not an agent
        function = entry.get("function") or {}
        text = function.get("description") or entry.get("instructions") or ""
        roles.append(AgentRole(name=str(entry["name"]),
                               role=_normalize(text)[:ROLE_TEXT_LIMIT]))
    return tuple(roles)


def load_identity(row: Dict[str, Any], out_dir: Optional[Path] = None) -> NetworkIdentity:
    """Build a NetworkIdentity from a persisted deployment row.

    Degrades rather than fails: a record whose bundle is gone still contributes its
    name, description and open slots, so it can take part in affinity scoring.
    """
    summary = row.get("network") or {}
    if out_dir is None:
        work_dir = row.get("work_dir")
        out_dir = Path(work_dir) / "site" if work_dir else None
    queries = [
        _normalize(query) for query in (summary.get("sample_queries") or [])
        if isinstance(query, str) and query.strip()
    ]
    return NetworkIdentity(
        deployment_id=str(row.get("id", "")),
        name=str(row.get("name", "")),
        description=_normalize(summary.get("description") or ""),
        front_man=str(summary.get("front_man") or ""),
        sample_queries=tuple(queries),
        agents=_agent_roles(out_dir, str(row.get("name", ""))) if out_dir else (),
        open_slots=tuple(
            slot for slot in (summary.get("link_slots") or []) if isinstance(slot, str)
        ),
    )


def identities_from_rows(rows: Iterable[Dict[str, Any]]) -> List[NetworkIdentity]:
    """Load every row that names a network, skipping unusable records."""
    return [load_identity(row) for row in rows if row.get("name")]


# --- scoring -----------------------------------------------------------------

@dataclass(frozen=True)
class Affinity:
    score: float
    shared: Tuple[str, ...]


def affinity(left: NetworkIdentity, right: NetworkIdentity,
             vocabulary: Vocabulary) -> Affinity:
    """Weighted Jaccard overlap of what two networks say about themselves."""
    left_terms = tokens(left.profile_text())
    right_terms = tokens(right.profile_text())
    if not left_terms or not right_terms:
        return Affinity(0.0, ())
    shared = left_terms & right_terms
    union_mass = vocabulary.mass(left_terms | right_terms)
    if union_mass <= 0:
        return Affinity(0.0, ())
    ranked = sorted(shared, key=lambda term: (-vocabulary.weight(term), term))
    return Affinity(vocabulary.mass(shared) / union_mass, tuple(ranked))


@dataclass(frozen=True)
class SlotMatch:
    reference: str
    coverage: float
    matched: Tuple[str, ...]


def slot_matches(consumer: NetworkIdentity, provider: NetworkIdentity,
                 vocabulary: Vocabulary,
                 min_coverage: float = DEFAULT_MIN_SLOT_COVERAGE) -> List[SlotMatch]:
    """Which of `consumer`'s open slots does `provider` look able to fill?

    Scored as coverage of the *slot's own* terms, not Jaccard: a slot named
    `fraud_and_payment_risk_manager` is satisfied by a provider that covers fraud,
    payment and risk, regardless of how much else that provider also does.
    """
    provider_terms = tokens(provider.capability_text())
    if not provider_terms:
        return []
    matches: List[SlotMatch] = []
    for reference in consumer.open_slots:
        slot_terms = tokens(_humanize(reference))
        if not slot_terms:
            continue
        slot_mass = vocabulary.mass(slot_terms)
        if slot_mass <= 0:
            continue
        covered = slot_terms & provider_terms
        coverage = vocabulary.mass(covered) / slot_mass
        if coverage >= min_coverage:
            ranked = sorted(covered, key=lambda term: (-vocabulary.weight(term), term))
            matches.append(SlotMatch(reference, coverage, tuple(ranked)))
    matches.sort(key=lambda match: (-match.coverage, match.reference))
    return matches


def _capability_reason(match: SlotMatch, provider: NetworkIdentity) -> str:
    terms = ", ".join(match.matched[:6])
    return (f"open slot '{match.reference}' matches what {provider.name} does "
            f"({terms}); {match.coverage:.0%} of the slot's terms covered")


def _affinity_reason(result: Affinity, other: NetworkIdentity) -> str:
    terms = ", ".join(result.shared[:6])
    return f"shares subject matter with {other.name} ({terms})"


def derive_relations(
    identities: Sequence[NetworkIdentity], *,
    max_per_network: int = DEFAULT_MAX_PER_NETWORK,
    min_affinity: float = DEFAULT_MIN_AFFINITY,
    min_slot_coverage: float = DEFAULT_MIN_SLOT_COVERAGE,
) -> List[SuggestedRelation]:
    """Suggest directed relations across every ordered pair of networks.

    A capability match always outranks bare affinity, because it rests on a declared
    hole rather than on two networks using similar words. At most one relation is
    emitted per ordered pair — the best evidence for it.
    """
    if len(identities) < 2:
        return []
    vocabulary = build_vocabulary(identities)
    by_source: Dict[str, List[SuggestedRelation]] = {}

    for consumer in identities:
        for provider in identities:
            if consumer.deployment_id == provider.deployment_id:
                continue
            best = slot_matches(consumer, provider, vocabulary, min_slot_coverage)
            if best:
                match = best[0]
                relation = SuggestedRelation(
                    source=consumer.deployment_id, target=provider.deployment_id,
                    kind="capability",
                    # Offset so any capability match sorts above any affinity one.
                    score=round(1.0 + match.coverage, 4),
                    reason=_capability_reason(match, provider),
                    reference=match.reference,
                )
            else:
                result = affinity(consumer, provider, vocabulary)
                if result.score < min_affinity:
                    continue
                relation = SuggestedRelation(
                    source=consumer.deployment_id, target=provider.deployment_id,
                    kind="affinity", score=round(result.score, 4),
                    reason=_affinity_reason(result, provider),
                )
            by_source.setdefault(relation.source, []).append(relation)

    suggestions: List[SuggestedRelation] = []
    for source in sorted(by_source):
        ranked = sorted(by_source[source], key=lambda item: (-item.score, item.target))
        suggestions.extend(ranked[:max_per_network])
    return suggestions


# --- optional LLM refinement -------------------------------------------------

# (system_prompt, user_payload) -> assistant content. Injected so the refiner is
# testable without a provider, and so the caller owns transport and credentials.
ChatFn = Callable[[str, str], str]

LLM_SYSTEM_PROMPT = (
    "You relate independently deployed agent networks to each other. Given each "
    "network's name, description, agents and unfilled references, decide which "
    "networks would usefully call which others. Return only JSON: "
    '{"relations":[{"source":"<id>","target":"<id>","reason":"<short why>"}]}. '
    "Use only the supplied ids, never invent one, and never relate a network to "
    "itself. Propose a useful edge only where one genuinely exists — two networks "
    "that do the same job are alternatives, not collaborators, so do not relate "
    "them. Returning an empty list is a valid answer."
)


def _llm_payload(identities: Sequence[NetworkIdentity]) -> str:
    return json.dumps({
        "networks": [
            {
                "id": identity.deployment_id,
                "name": identity.name,
                "description": identity.description,
                "agents": [agent.name for agent in identity.agents][:12],
                "unfilled_references": list(identity.open_slots)[:12],
            }
            for identity in identities
        ]
    })


def _parse_llm_relations(content: str, known: Dict[str, NetworkIdentity],
                         ) -> List[SuggestedRelation]:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(content or "").strip(), flags=re.I)
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("relation model did not return an object")
    relations: List[SuggestedRelation] = []
    seen: set[Tuple[str, str]] = set()
    for item in (payload.get("relations") or []):
        if not isinstance(item, dict):
            continue
        source, target = str(item.get("source", "")), str(item.get("target", ""))
        if source not in known or target not in known or source == target:
            continue
        if (source, target) in seen:
            continue
        seen.add((source, target))
        relations.append(SuggestedRelation(
            source=source, target=target, kind="model",
            score=1.0, origin="llm",
            reason=_normalize(item.get("reason") or
                              f"related to {known[target].name}")[:300],
        ))
    return relations


def suggest_relations(
    identities: Sequence[NetworkIdentity], *,
    chat: Optional[ChatFn] = None,
    max_per_network: int = DEFAULT_MAX_PER_NETWORK,
    min_affinity: float = DEFAULT_MIN_AFFINITY,
    min_slot_coverage: float = DEFAULT_MIN_SLOT_COVERAGE,
) -> Tuple[List[SuggestedRelation], str]:
    """The entry point: suggested relations plus which strategy produced them.

    Mirrors Cailville's contract — ask the model when one is available, fall back to
    the deterministic scorer on any failure, so the feature never depends on a key.
    """
    heuristic = derive_relations(
        identities, max_per_network=max_per_network, min_affinity=min_affinity,
        min_slot_coverage=min_slot_coverage)
    if chat is None or len(identities) < 2:
        return heuristic, "heuristic"
    known = {identity.deployment_id: identity for identity in identities}
    try:
        proposed = _parse_llm_relations(
            chat(LLM_SYSTEM_PROMPT, _llm_payload(identities)), known)
    except Exception:
        # A model that is unavailable, slow or malformed must not take the view down.
        return heuristic, "heuristic"
    if not proposed:
        # An explicit empty list is a real answer, but so is a confused one; the
        # deterministic result is the more useful thing to show.
        return heuristic, "heuristic"
    by_source: Dict[str, List[SuggestedRelation]] = {}
    for relation in proposed:
        by_source.setdefault(relation.source, []).append(relation)
    capped: List[SuggestedRelation] = []
    for source in sorted(by_source):
        capped.extend(by_source[source][:max_per_network])
    return capped, "llm"
