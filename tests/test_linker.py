import json
import tempfile
import unittest
from pathlib import Path

from nsdeploy.generate import (build_manifest, build_private_steward_hocon, generate_site,
                               rewrite_config, write_private_steward_manifest)
from nsdeploy.linker import NetworkDescription, describe_config, load_link_file, write_link_file
from nsdeploy.resolve import DEMO_MODE_MARKER, DeploymentPlan, HostableTool, build_plan
from nsdeploy.studio import LocalStudio
from nsdeploy.theme import ThemeSpec


class LinkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = LocalStudio(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_dangling_reference_becomes_link_slot(self):
        config = {
            "tools": [{
                "name": "travel_concierge",
                "instructions": "Arrange a trip.",
                "tools": ["airline_reservations"],
            }]
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        self.assertEqual(plan.missing_tools, [])
        self.assertEqual(plan.link_slots, {"airline_reservations": ["travel_concierge"]})

        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)
        self.assertEqual(deployed["tools"][0]["tools"], ["airline_reservations"])
        self.assertIn("airline_reservations", deployed["link_slots"])

    def test_configured_link_rewrites_reference_to_remote_network(self):
        config = {
            "links": {"airline_reservations": "http://127.0.0.1:8092/link_demo_airline"},
            "tools": [{
                "name": "travel_concierge",
                "instructions": "Arrange a trip.",
                "tools": ["airline_reservations"],
            }],
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)
        self.assertEqual(
            deployed["tools"][0]["tools"],
            ["http://127.0.0.1:8092/link_demo_airline"],
        )
        self.assertEqual(deployed["link_slots"], {})

    def test_direct_url_tool_is_preserved_as_public_agent_network(self):
        remote = "http://127.0.0.1:8093/seabreeze_inn"
        config = {
            "tools": [{
                "name": "commercial_sales_manager",
                "instructions": "Coordinate farm sales.",
                "tools": [remote],
            }],
        }
        plan = build_plan(config, {}, "greenbank_farm", [], self.source)

        self.assertEqual(plan.external_networks, [remote])
        self.assertEqual(plan.external_mcps, [])
        deployed = rewrite_config(plan, "http://127.0.0.1:8094", cruse=False)
        self.assertEqual(deployed["tools"][0]["tools"], [remote])

        manifest = build_manifest(
            plan, deployed,
            "http://127.0.0.1:8094/v1",
            "http://127.0.0.1:8094/byok/v1",
            "http://127.0.0.1:8094",
            ThemeSpec(),
        )
        self.assertIn("http://127.0.0.1:8093", manifest["allowed_peers"])

    def test_mcp_url_is_not_classified_as_public_agent_network(self):
        remote = "https://tools.example/mcp"
        config = {
            "tools": [{
                "name": "front",
                "instructions": "Help.",
                "tools": [remote],
            }],
        }
        plan = build_plan(config, {}, "demo", [], self.source)

        self.assertEqual(plan.external_mcps, [remote])
        self.assertEqual(plan.external_networks, [])

    def test_static_plan_skips_python_tool_resolution(self):
        config = {"tools": [
            {"name": "front", "instructions": "Help.", "tools": ["private_search"]},
            {"name": "private_search", "class": "missing.Search"},
        ]}
        plan = build_plan(
            config, {}, "portable", [], self.source, include_python_tools=False,
        )
        self.assertEqual(plan.hostable_tools, [])
        self.assertEqual(plan.missing_tools, [])
        self.assertEqual(plan.omitted_tools, ["private_search"])

    def test_unlinked_demo_leaf_remains_as_local_fallback(self):
        config = {
            "tools": [
                {
                    "name": "travel_concierge",
                    "instructions": "Arrange a trip.",
                    "tools": ["link_demo_airline"],
                },
                {
                    "name": "link_demo_airline",
                    "instructions": DEMO_MODE_MARKER,
                    "tools": [],
                },
            ],
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)

        self.assertEqual(plan.demo_link_fallbacks, ["link_demo_airline"])
        self.assertEqual(plan.replaced_agents, [])
        self.assertEqual([item["name"] for item in deployed["tools"]],
                         ["travel_concierge", "link_demo_airline"])
        self.assertEqual(deployed["tools"][0]["tools"], ["link_demo_airline"])

    def test_link_replaces_same_named_demo_leaf(self):
        config = {
            "links": {"link_demo_airline": "http://127.0.0.1:8092/link_demo_airline"},
            "tools": [
                {
                    "name": "travel_concierge",
                    "instructions": "Arrange a trip.",
                    "tools": ["link_demo_airline"],
                },
                {
                    "name": "link_demo_airline",
                    "instructions": DEMO_MODE_MARKER,
                    "tools": [],
                },
            ],
        }
        plan = build_plan(config, {}, "travel_agency", [], self.source)
        deployed = rewrite_config(plan, "http://127.0.0.1:8091", cruse=False)

        self.assertEqual(plan.replaced_agents, ["link_demo_airline"])
        self.assertEqual([item["name"] for item in deployed["tools"]], ["travel_concierge"])
        self.assertEqual(
            deployed["tools"][0]["tools"],
            ["http://127.0.0.1:8092/link_demo_airline"],
        )

    def test_sidecar_round_trip(self):
        path = self.root / "travel.links.json"
        expected = {"airline_reservations": "http://127.0.0.1:8092/link_demo_airline"}
        write_link_file(path, "travel", expected)
        self.assertEqual(load_link_file(path, "travel"), expected)
        self.assertEqual(json.loads(path.read_text())["version"], 1)

    def test_callee_exports_only_its_own_identity_by_default(self):
        config = {
            "tools": [{"name": "airline_front", "instructions": "Book flights."}],
        }
        desc = describe_config(config, "link_demo_airline")
        self.assertIsInstance(desc, NetworkDescription)
        self.assertEqual(desc.aliases, ["link_demo_airline", "airline_front"])

    def test_linker_discovers_referenced_demo_leaf(self):
        config = {
            "tools": [
                {
                    "name": "travel_concierge",
                    "instructions": "Arrange a trip.",
                    "tools": ["link_demo_airline"],
                },
                {
                    "name": "link_demo_airline",
                    "instructions": DEMO_MODE_MARKER,
                },
            ],
        }
        desc = describe_config(config, "travel_agency")
        self.assertEqual(desc.imports, {"link_demo_airline": ["travel_concierge"]})

    def test_hosted_tool_uses_same_origin_proxy_and_manifest_allows_it(self):
        tool = HostableTool("search", "x.Search", "coded_tools.x", "Search", "Search", {})
        plan = DeploymentPlan(
            network_name="demo", config={"tools": []}, front_man="front",
            hostable_tools=[tool],
        )
        site = "http://127.0.0.1:8091"
        plan.config = {
            "tools": [{"name": "front", "instructions": "Help.", "tools": ["search"]}]
        }
        config = rewrite_config(plan, site, cruse=False)
        self.assertEqual(config["tools"][0]["tools"], [f"{site}/_mcp/0/mcp"])
        manifest = build_manifest(plan, config, f"{site}/v1", f"{site}/byok/v1", site, ThemeSpec())
        self.assertIn(site, manifest["allowed_peers"])
        self.assertEqual(manifest["peer_policy"]["mode"], "open")
        self.assertEqual(manifest["agent_mcp"]["endpoint"], f"{site}/mcp")
        self.assertEqual(manifest["agent_mcp"]["llm_credentials"]["mode"], "caller-byok")
        self.assertTrue(manifest["agent_mcp"]["llm_credentials"]["required"])

    def test_private_steward_is_generated_for_any_public_site(self):
        plan = DeploymentPlan(
            network_name="harbor_services", config={"metadata": {"description": "Harbor services"}},
            front_man="harbor_front",
            links={"harbor_guide": "http://127.0.0.1:8091/harbor_guide"},
        )
        hocon = build_private_steward_hocon(
            plan,
            "https://harbor.example",
            {"town_hall": "https://town-hall.example"},
        )
        self.assertIn('"class": "nsdeploy.steward.PublicAgentNetworkGateway"', hocon)
        self.assertIn('"mode": "fetch-and-run"', hocon)
        self.assertIn('"max_execution_seconds": 3600', hocon)
        self.assertIn('"mode": "open"', hocon)
        self.assertIn("https://harbor.example/mcp", hocon)
        self.assertIn("https://harbor.example/harbor_services", hocon)
        self.assertIn("http://127.0.0.1:8091/harbor_guide", hocon)
        self.assertIn("https://town-hall.example", hocon)
        self.assertIn("Never invent example domains or hostnames", hocon)
        self.assertIn("After the operator confirms an action", hocon)

    def test_generated_steward_filename_includes_network_name(self):
        plan = DeploymentPlan(
            network_name="harbor_services", config={"tools": [{"name": "front", "instructions": "Help."}]},
            front_man="front",
        )
        out = self.root / "site"
        generate_site(plan, out, "http://127.0.0.1:8091/v1", "http://127.0.0.1:8091/byok/v1",
                      "http://127.0.0.1:8091", cruse=False)
        self.assertTrue((out / "harbor_services_private_steward.hocon").is_file())
        self.assertFalse((out / "private-steward.hocon").exists())
        manifest = out.parent / "manifest.hocon"
        self.assertTrue(manifest.is_file())
        contents = manifest.read_text()
        self.assertIn('"site/harbor_services_private_steward.hocon": true', contents)
        self.assertNotIn(str(manifest.parent.resolve()), contents)

    def test_static_bundle_is_self_contained_and_omits_server_features(self):
        python_tool = HostableTool(
            "search", "x.Search", "coded_tools.x", "Search", "Search", {},
        )
        direct_mcp = "https://tools.example/mcp"
        plan = DeploymentPlan(
            network_name="portable",
            config={"tools": [{
                "name": "front", "instructions": "Help.",
                "tools": ["search", direct_mcp],
            }]},
            front_man="front",
            hostable_tools=[python_tool],
            external_mcps=[direct_mcp],
        )
        out = self.root / "portable"
        runtime = self.root / "runtime-source"
        runtime.mkdir()
        (runtime / "index.js").write_text("export const boot = () => {};\n")
        (runtime / "sandbox-worker.js").write_text("// worker\n")

        manifest = generate_site(
            plan, out, "browser://mock", "https://api.example/v1", "",
            cruse=False, static_bundle=True, runtime_dir=runtime,
        )

        config = json.loads((out / "portable.network.json").read_text())
        self.assertEqual(config["tools"][0]["tools"], [direct_mcp])
        self.assertEqual(config["deployment"]["omitted_python_tools"], ["search"])
        self.assertEqual(manifest["llm_router"]["base_url"], "browser://mock")
        self.assertEqual(manifest["networks"][0]["front_man"], "front")
        self.assertFalse(manifest["agent_mcp"]["available"])
        self.assertEqual(manifest["linking"]["link_updates"]["mode"], "browser-local")
        self.assertTrue((out / "runtime" / "index.js").is_file())
        self.assertTrue((out / "_headers").is_file())
        self.assertTrue((out / ".htaccess").is_file())
        self.assertTrue((out / "STATIC_HOSTING.md").is_file())
        self.assertTrue((out / "portable_private_steward.hocon").is_file())
        self.assertIn(
            '"class": "nsdeploy.steward.PublicAgentNetworkGateway"',
            (out / "portable_private_steward.hocon").read_text(),
        )
        self.assertIn(
            "private steward can fetch and run",
            (out / "STATIC_HOSTING.md").read_text(),
        )
        index = (out / "index.html").read_text()
        self.assertIn('from "./runtime/index.js"', index)
        self.assertIn('href="./theme.css"', index)

    def test_static_bundle_loads_the_ts_package_runtime_unless_switched_off(self):
        plan = DeploymentPlan(
            network_name="portable", config={"tools": [{"name": "front", "instructions": "Help."}]},
            front_man="front",
        )
        runtime = self.root / "runtime-source"
        runtime.mkdir()
        (runtime / "index.js").write_text("// original\n")
        for ts_package in (True, False):
            out = self.root / f"portable-{ts_package}"
            generate_site(plan, out, "browser://mock", "https://api.example/v1", "",
                          cruse=False, static_bundle=True, runtime_dir=runtime, ts_package=ts_package)
            index = (out / "runtime" / "index.js").read_text()
            if ts_package:
                self.assertEqual(index, 'export * from "./ts-package/index.js";\n')
            else:
                self.assertEqual(index, "// original\n")
        self.assertEqual((runtime / "index.js").read_text(), "// original\n")

    def test_private_steward_manifest_collects_multiple_bundles(self):
        root = self.root / "cailville"
        (root / "harbor_guide").mkdir(parents=True)
        (root / "deneman_place").mkdir(parents=True)
        (root / "harbor_guide" / "harbor_guide_private_steward.hocon").write_text("{}")
        (root / "deneman_place" / "deneman_place_private_steward.hocon").write_text("{}")
        manifest = write_private_steward_manifest(root)
        contents = manifest.read_text()
        self.assertIn('"harbor_guide/harbor_guide_private_steward.hocon": true', contents)
        self.assertIn('"deneman_place/deneman_place_private_steward.hocon": true', contents)
        self.assertNotIn(str(root.resolve()), contents)
        self.assertLess(contents.index("deneman_place_private_steward"),
                        contents.index("harbor_guide_private_steward"))

        manifest = write_private_steward_manifest(root, active_networks=["deneman_place"])
        contents = manifest.read_text()
        self.assertIn("deneman_place_private_steward", contents)
        self.assertNotIn("harbor_guide_private_steward", contents)


if __name__ == "__main__":
    unittest.main()
