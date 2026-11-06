"""Relation inference over deployed networks' descriptions.

The scorer is pure, so everything here runs without a service, a provider, or a
network. The LLM strategy is exercised through an injected chat function.
"""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings
from nsdeploy_service.relations import (
    AgentRole,
    NetworkIdentity,
    affinity,
    build_vocabulary,
    derive_relations,
    identities_from_rows,
    load_identity,
    slot_matches,
    suggest_relations,
    tokens,
)


# pylint: disable-next=too-many-arguments,too-many-positional-arguments  # fixture builder mirrors NetworkIdentity
def identity(deployment_id, name, description="", agents=(), slots=(), queries=()):
    """
    Build a NetworkIdentity fixture.

    :param deployment_id: The deployment id.
    :param name: The network name.
    :param description: The network description.
    :param agents: (name, role) pairs for the network's agents.
    :param slots: The network's open link slots.
    :param queries: The network's sample queries.
    :return: The NetworkIdentity.
    """
    return NetworkIdentity(
        deployment_id=deployment_id, name=name, description=description,
        agents=tuple(AgentRole(n, r) for n, r in agents),
        open_slots=tuple(slots), sample_queries=tuple(queries),
    )


# Two complementary networks plus one unrelated, which is the shape real inference
# has to get right: relate the first two, leave the third alone.
ORDERS = identity(
    "d_orders", "store_order_management_system",
    description="Leads end-to-end store order operations across intake, fulfillment "
                "and post-purchase service, setting SLAs and decision policies.",
    agents=[("order_intake_manager", "validates and captures incoming orders"),
            ("fulfillment_manager", "allocates inventory and schedules shipment")],
    slots=["carrier_shipping_manager", "fraud_and_payment_risk_manager"],
)
SHIPPING = identity(
    "d_ship", "carrier_shipping_manager",
    description="Books carrier shipping, produces labels and tracks parcel delivery "
                "exceptions for retail orders.",
    agents=[("label_agent", "produces carrier shipping labels"),
            ("tracking_agent", "monitors parcel delivery and carrier exceptions")],
)
RECIPES = identity(
    "d_food", "recipe_recommender",
    description="Suggests dinner recipes from pantry ingredients and dietary "
                "preferences, with cooking steps.",
    agents=[("pantry_agent", "reads available ingredients"),
            ("nutrition_agent", "checks dietary preferences")],
)


class TokenizerTest(unittest.TestCase):
    """Tokenizes profile text into significant words."""
    def test_splits_identifiers_into_words(self):
        """Splits identifiers into words."""
        self.assertEqual(tokens("order_intake-manager"), {"order", "intake", "manager"})

    def test_drops_stop_words_and_short_words(self):
        """Drops stop words and short words."""
        self.assertEqual(tokens("the agent will handle a request for us"), set())

    def test_is_case_insensitive(self):
        """Is case insensitive."""
        self.assertEqual(tokens("Carrier SHIPPING"), {"carrier", "shipping"})


class VocabularyTest(unittest.TestCase):
    """Weights terms by how rare they are across networks."""
    def test_a_term_every_network_shares_is_worth_less_than_a_rare_one(self):
        """Boilerplate identical across networks must not drive the score — this is
        what keeps the injected CRUSE directive out of the result without the scorer
        needing to know it exists. Uses a purpose-built corpus so the shared term is
        unambiguous."""
        corpus = [
            identity("a", "alpha", description="boilerplate distinctive"),
            identity("b", "beta", description="boilerplate ordinary"),
            identity("c", "gamma", description="boilerplate ordinary"),
        ]
        vocab = build_vocabulary(corpus)
        self.assertLess(vocab.weight("boilerplate"), vocab.weight("distinctive"))

    def test_an_unseen_term_gets_the_highest_weight(self):
        """An unseen term gets the highest weight."""
        vocab = build_vocabulary([ORDERS, SHIPPING])
        self.assertGreater(vocab.weight("never_mentioned"), vocab.weight("order"))

    def test_weights_stay_positive_with_only_two_networks(self):
        """Weights stay positive with only two networks."""
        # Plain log(N/df) would zero out every shared term here.
        vocab = build_vocabulary([ORDERS, SHIPPING])
        for term in tokens(ORDERS.profile_text()):
            with self.subTest(term=term):
                self.assertGreater(vocab.weight(term), 0)


class AffinityTest(unittest.TestCase):
    """Scores shared subject matter between two networks."""
    def setUp(self):
        self.vocab = build_vocabulary([ORDERS, SHIPPING, RECIPES])

    def test_same_domain_scores_above_different_domain(self):
        """Same domain scores above different domain."""
        related = affinity(ORDERS, SHIPPING, self.vocab).score
        unrelated = affinity(ORDERS, RECIPES, self.vocab).score
        self.assertGreater(related, unrelated)

    def test_reports_the_shared_vocabulary_as_evidence(self):
        """Reports the shared vocabulary as evidence."""
        shared = set(affinity(ORDERS, SHIPPING, self.vocab).shared)
        self.assertIn("orders", shared)
        self.assertTrue(shared.issubset(tokens(ORDERS.profile_text())))

    def test_open_slots_are_not_part_of_affinity(self):
        """A slot is a demand, not a self-description. `carrier` reaches ORDERS only
        through its open slot, so it must not count as shared subject matter — that
        is what the capability signal is for."""
        self.assertIn("carrier", tokens(SHIPPING.profile_text()))
        self.assertNotIn("carrier", tokens(ORDERS.profile_text()))
        self.assertNotIn("carrier", affinity(ORDERS, SHIPPING, self.vocab).shared)

    def test_is_symmetric(self):
        """Is symmetric."""
        self.assertAlmostEqual(affinity(ORDERS, SHIPPING, self.vocab).score,
                               affinity(SHIPPING, ORDERS, self.vocab).score)

    def test_an_empty_identity_scores_zero(self):
        """An empty identity scores zero."""
        blank = identity("d_blank", "")
        self.assertEqual(affinity(ORDERS, blank, self.vocab).score, 0.0)


class SlotMatchTest(unittest.TestCase):
    """Matches a network's open slots to providers that cover them."""
    def setUp(self):
        self.vocab = build_vocabulary([ORDERS, SHIPPING, RECIPES])

    def test_matches_an_open_slot_to_a_provider_that_covers_it(self):
        """Matches an open slot to a provider that covers it."""
        matches = slot_matches(ORDERS, SHIPPING, self.vocab)
        self.assertEqual([match.reference for match in matches],
                         ["carrier_shipping_manager"])

    def test_reports_which_terms_were_covered(self):
        """Reports which terms were covered."""
        match = slot_matches(ORDERS, SHIPPING, self.vocab)[0]
        self.assertIn("carrier", match.matched)
        self.assertGreaterEqual(match.coverage, 0.5)

    def test_an_unrelated_provider_matches_nothing(self):
        """An unrelated provider matches nothing."""
        self.assertEqual(slot_matches(ORDERS, RECIPES, self.vocab), [])

    def test_a_network_with_no_open_slots_consumes_nothing(self):
        """A network with no open slots consumes nothing."""
        self.assertEqual(slot_matches(SHIPPING, ORDERS, self.vocab), [])


class DeriveRelationsTest(unittest.TestCase):
    """Derives directed relations across a set of networks."""
    def test_capability_relation_wins_and_names_the_slot(self):
        """Capability relation wins and names the slot."""
        relations = derive_relations([ORDERS, SHIPPING, RECIPES])
        found = [r for r in relations if r.source == "d_orders" and r.target == "d_ship"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].kind, "capability")
        self.assertEqual(found[0].reference, "carrier_shipping_manager")
        self.assertIn("carrier_shipping_manager", found[0].reason)

    def test_capability_always_outranks_affinity(self):
        """Capability always outranks affinity."""
        relations = derive_relations([ORDERS, SHIPPING, RECIPES])
        capability = [r.score for r in relations if r.kind == "capability"]
        affinities = [r.score for r in relations if r.kind == "affinity"]
        if affinities:
            self.assertGreater(min(capability), max(affinities))

    def test_unrelated_networks_are_not_related(self):
        """Unrelated networks are not related."""
        relations = derive_relations([ORDERS, SHIPPING, RECIPES])
        pairs = {(r.source, r.target) for r in relations}
        self.assertNotIn(("d_orders", "d_food"), pairs)
        self.assertNotIn(("d_food", "d_orders"), pairs)

    def test_never_relates_a_network_to_itself(self):
        """Never relates a network to itself."""
        for relation in derive_relations([ORDERS, SHIPPING, RECIPES]):
            self.assertNotEqual(relation.source, relation.target)

    def test_a_single_network_yields_nothing(self):
        """A single network yields nothing."""
        self.assertEqual(derive_relations([ORDERS]), [])

    def test_no_networks_yields_nothing(self):
        """No networks yields nothing."""
        self.assertEqual(derive_relations([]), [])

    def test_respects_the_per_network_cap(self):
        """Respects the per network cap."""
        many = [ORDERS, SHIPPING] + [
            identity(f"d{i}", f"order_helper_{i}",
                     description="handles retail order fulfillment and delivery")
            for i in range(6)
        ]
        relations = derive_relations(many, max_per_network=2)
        for source in {r.source for r in relations}:
            with self.subTest(source=source):
                self.assertLessEqual(
                    sum(1 for r in relations if r.source == source), 2)

    def test_relations_are_directed(self):
        """Orders declares the slot, so orders -> shipping is a capability edge and
        the reverse can never be one: direction comes from who states the need."""
        relations = derive_relations([ORDERS, SHIPPING])
        forward = next(r for r in relations
                       if r.source == "d_orders" and r.target == "d_ship")
        self.assertEqual(forward.kind, "capability")
        reverse_capabilities = [
            r for r in relations
            if r.source == "d_ship" and r.target == "d_orders" and r.kind == "capability"
        ]
        self.assertEqual(reverse_capabilities, [])


class IdentityLoadingTest(unittest.TestCase):
    """Loads a NetworkIdentity from a deployment row and its bundle."""
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.work = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _row(self, name="net", with_bundle=True, agents=None):
        out = self.work / "site"
        if with_bundle:
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{name}.network.json").write_text(json.dumps({
                "tools": agents if agents is not None else [
                    {"name": "front", "instructions": "long protocol text",
                     "function": {"description": "coordinates carrier shipping"}},
                    {"name": "leaf", "class": "x.Y"},
                ],
            }), encoding="utf-8")
        return {
            "id": "dep1", "name": name, "work_dir": str(self.work),
            "network": {"description": "a shipping network", "front_man": "front",
                        "sample_queries": ["where is my parcel"],
                        "link_slots": ["payment_manager"]},
        }

    def test_reads_description_front_man_queries_and_slots_from_the_record(self):
        """Reads description front man queries and slots from the record."""
        loaded = load_identity(self._row())
        self.assertEqual(loaded.description, "a shipping network")
        self.assertEqual(loaded.front_man, "front")
        self.assertEqual(loaded.sample_queries, ("where is my parcel",))
        self.assertEqual(loaded.open_slots, ("payment_manager",))

    def test_reads_agent_roles_from_the_bundle(self):
        """Reads agent roles from the bundle."""
        loaded = load_identity(self._row())
        self.assertEqual([a.name for a in loaded.agents], ["front"])
        self.assertEqual(loaded.agents[0].role, "coordinates carrier shipping")

    def test_prefers_function_description_over_instructions(self):
        """Instructions carry AAOSA protocol text and the injected CRUSE directive,
        which are identical across networks and describe none of them."""
        loaded = load_identity(self._row())
        self.assertNotIn("protocol", loaded.agents[0].role)

    def test_falls_back_to_instructions_when_there_is_no_description(self):
        """Falls back to instructions when there is no description."""
        row = self._row(agents=[{"name": "front", "instructions": "books freight"}])
        self.assertEqual(load_identity(row).agents[0].role, "books freight")

    def test_a_missing_bundle_degrades_instead_of_failing(self):
        """A missing bundle degrades instead of failing."""
        loaded = load_identity(self._row(with_bundle=False))
        self.assertEqual(loaded.agents, ())
        self.assertEqual(loaded.description, "a shipping network")

    def test_skips_rows_with_no_network_name(self):
        """Skips rows with no network name."""
        rows = [self._row(), {"id": "x", "name": "", "network": {}}]
        self.assertEqual(len(identities_from_rows(rows)), 1)

    def test_sample_queries_do_not_pollute_capability_text(self):
        """Sample queries do not pollute capability text."""
        loaded = load_identity(self._row())
        self.assertIn("parcel", loaded.profile_text())
        self.assertNotIn("parcel", loaded.capability_text())


class LlmStrategyTest(unittest.TestCase):
    """Uses an injected chat function and falls back to the scorer."""
    def test_uses_the_model_result_when_it_is_usable(self):
        """Uses the model result when it is usable."""
        def chat(_system, _user):
            return json.dumps({"relations": [
                {"source": "d_orders", "target": "d_ship", "reason": "needs carriers"}]})

        edges, strategy = suggest_relations([ORDERS, SHIPPING, RECIPES], chat=chat)
        self.assertEqual(strategy, "llm")
        self.assertEqual([(e.source, e.target) for e in edges], [("d_orders", "d_ship")])
        self.assertEqual(edges[0].reason, "needs carriers")
        self.assertEqual(edges[0].origin, "llm")

    def test_tolerates_a_fenced_code_block(self):
        """Tolerates a fenced code block."""
        def chat(_system, _user):
            return ('```json\n{"relations": [{"source": "d_orders", '
                    '"target": "d_ship", "reason": "r"}]}\n```')

        edges, strategy = suggest_relations([ORDERS, SHIPPING], chat=chat)
        self.assertEqual(strategy, "llm")
        self.assertEqual(len(edges), 1)

    def test_discards_ids_the_model_invented(self):
        """Discards ids the model invented."""
        def chat(_system, _user):
            return json.dumps({"relations": [
                {"source": "d_orders", "target": "does_not_exist", "reason": "x"},
                {"source": "d_orders", "target": "d_ship", "reason": "ok"}]})

        edges, _ = suggest_relations([ORDERS, SHIPPING], chat=chat)
        self.assertEqual([e.target for e in edges], ["d_ship"])

    def test_discards_a_self_relation(self):
        """Discards a self relation."""
        def chat(_system, _user):
            return json.dumps({"relations": [
                {"source": "d_orders", "target": "d_orders", "reason": "x"}]})

        edges, strategy = suggest_relations([ORDERS, SHIPPING], chat=chat)
        self.assertEqual(strategy, "heuristic")  # nothing usable survived
        self.assertTrue(all(e.source != e.target for e in edges))

    def test_falls_back_to_the_scorer_when_the_model_raises(self):
        """Falls back to the scorer when the model raises."""
        def chat(_system, _user):
            raise RuntimeError("provider down")

        edges, strategy = suggest_relations([ORDERS, SHIPPING], chat=chat)
        self.assertEqual(strategy, "heuristic")
        self.assertTrue(edges)

    def test_falls_back_when_the_model_returns_junk(self):
        """Falls back when the model returns junk."""
        edges, strategy = suggest_relations(
            [ORDERS, SHIPPING], chat=lambda system, user: "sorry, I cannot help")
        self.assertEqual(strategy, "heuristic")
        self.assertTrue(edges)

    def test_no_chat_function_means_the_deterministic_scorer(self):
        """No chat function means the deterministic scorer."""
        edges, strategy = suggest_relations([ORDERS, SHIPPING])
        self.assertEqual(strategy, "heuristic")
        self.assertTrue(edges)


class RelationsEndpointTest(unittest.TestCase):
    """The API projection, exercised through the real endpoints."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)
        # Bundles on disk; the rows themselves are written once the app is up.
        for deployment_id, spec in (("d_orders", ORDERS), ("d_ship", SHIPPING)):
            out_dir = self.root / deployment_id / "site"
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"{spec.name}.network.json").write_text(json.dumps({
                "tools": [{"name": agent.name, "instructions": "x",
                           "function": {"description": agent.role}}
                          for agent in spec.agents],
            }), encoding="utf-8")
            (self.root / deployment_id / "nsdeploy.log").write_text("", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def _settings(self):
        return Settings(work_root=self.root, port_start=8860, port_end=8879)

    def _seed(self, supervisor):
        """Two complementary networks, published and serving.

        Written after start-up: reconcile_orphans settles any live row at boot, and
        the map now requires `ready`, so a row seeded beforehand would be `stopped`
        and absent from /graph.
        """
        org = supervisor.fallback_org
        for deployment_id, spec in (("d_orders", ORDERS), ("d_ship", SHIPPING)):
            work_dir = self.root / deployment_id
            supervisor.store.save_deployment({
                "id": deployment_id, "org_id": org["id"], "name": spec.name,
                "status": "ready", "url": f"http://127.0.0.1:886{deployment_id[-1]}",
                "port": None, "created_at": "2026-09-23T18:00:00+00:00",
                "ready_at": "2026-09-23T18:00:00+00:00", "stopped_at": None,
                "expires_at": None, "error": None, "pid": None,
                "network_json": json.dumps({
                    "front_man": spec.front_man, "agent_count": len(spec.agents),
                    "description": spec.description,
                    "sample_queries": list(spec.sample_queries),
                    "link_slots": list(spec.open_slots),
                }),
                "warnings_json": None,
                "log_path": str(work_dir / "nsdeploy.log"),
                "work_dir": str(work_dir),
            })
            # This case is about relations, not the publish gate (which
            # tests/test_service_publish.py covers).
            supervisor.store.set_published(deployment_id, "2026-09-23T18:00:00+00:00")

    def _get(self, path):
        with TestClient(create_app(self._settings())) as client:
            self._seed(client.app.state.supervisor)
            response = client.get(path)
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()

    def test_relations_endpoint_reports_the_capability_edge(self):
        """Relations endpoint reports the capability edge."""
        body = self._get("/relations")
        self.assertEqual(body["strategy"], "heuristic")
        self.assertEqual(body["networks"], 2)
        edge = next(e for e in body["edges"]
                    if e["source"] == "d_orders" and e["target"] == "d_ship")
        self.assertEqual(edge["kind"], "capability")
        self.assertEqual(edge["reference"], "carrier_shipping_manager")
        self.assertTrue(edge["reason"])

    def test_graph_exposes_suggestions_separately_from_real_links(self):
        """The map must never present an inference as a wired connection."""
        body = self._get("/graph?suggest=true")
        self.assertEqual(body["edges"], [])          # nothing is actually linked
        self.assertTrue(body["suggested_edges"])     # but a relation was inferred
        self.assertEqual(body["totals"]["suggested_edges"],
                         len(body["suggested_edges"]))

    def test_graph_does_not_infer_relations_unless_asked(self):
        """The default is off, and that is a performance contract, not a detail.

        The scorer is pairwise, so it grows with the square of the map: on a
        100-network map it measured ~4.4s of a ~4.4s response and three quarters of
        the payload, for suggestions views/map.js discards. A regression here would
        not fail any other test — it would just make the map slow to open again.
        """
        body = self._get("/graph")
        self.assertEqual(body["suggested_edges"], [])
        self.assertEqual(body["totals"]["suggested_edges"], 0)
        # The real links are unaffected by the switch.
        self.assertEqual(body["edges"], [])
        self.assertTrue(body["nodes"])

    def test_suggested_edges_only_reference_visible_nodes(self):
        """Suggested edges only reference visible nodes."""
        # Asks for suggestions explicitly: against the default they are empty and the
        # loop below would pass without examining anything.
        body = self._get("/graph?suggest=true")
        ids = {node["id"] for node in body["nodes"]}
        self.assertTrue(body["suggested_edges"], "nothing was inferred to check")
        for edge in body["suggested_edges"]:
            with self.subTest(edge=edge):
                self.assertIn(edge["source"], ids)
                self.assertIn(edge["target"], ids)

    def test_llm_strategy_falls_back_when_no_key_is_configured(self):
        """Llm strategy falls back when no key is configured."""
        # RELATIONS_LLM is off by default, so asking for it must degrade, not fail.
        body = self._get("/relations?strategy=llm")
        self.assertEqual(body["strategy"], "heuristic")

    def test_unknown_org_filter_is_rejected(self):
        """Unknown org filter is rejected."""
        with TestClient(create_app(self._settings())) as client:
            self.assertEqual(client.get("/relations?org_id=nope").status_code, 404)


class ConsoleCachingTest(unittest.TestCase):
    """The console's entry document must always revalidate.

    Regression: StaticFiles sent no Cache-Control, so browsers applied heuristic
    freshness and kept serving a pre-release index.html. Because the asset URLs are
    versioned inside that document, a stale entry point pinned every stylesheet and
    script to the old version too — the console went stale as a whole and only a
    manual hard reload cleared it.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _client(self):
        return TestClient(create_app(
            Settings(work_root=self.root, port_start=8840, port_end=8849)))

    def test_entry_document_is_not_heuristically_cacheable(self):
        """Entry document is not heuristically cacheable."""
        with self._client() as client:
            response = client.get("/app/")
            self.assertEqual(response.status_code, 200)
            self.assertIn("text/html", response.headers["content-type"])
            self.assertEqual(response.headers.get("cache-control"), "no-cache")

    def test_versioned_assets_are_left_cacheable(self):
        """Versioned assets are left cacheable."""
        with self._client() as client:
            response = client.get("/app/assets/styles/layout.css")
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.headers.get("cache-control"))

    def test_entry_document_still_revalidates_with_an_etag(self):
        """no-cache means "ask first", not "never cache" — the 304 path must survive."""
        with self._client() as client:
            first = client.get("/app/")
            etag = first.headers.get("etag")
            self.assertIsNotNone(etag)
            again = client.get("/app/", headers={"If-None-Match": etag})
            self.assertEqual(again.status_code, 304)


if __name__ == "__main__":
    unittest.main()
