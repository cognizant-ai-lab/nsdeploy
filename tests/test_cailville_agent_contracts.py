from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CAILVILLE = ROOT / "cailville"


def test_harbor_guide_requires_partner_delegation_without_broken_search_provider():
    source = (CAILVILLE / "harbor_guide.hocon").read_text(encoding="utf-8")

    assert "MANDATORY TOOL POLICY" in source
    assert "declared partner such as hours or availability" in source
    assert '"temperature": 0' in source
    assert "https://api.you.com/mcp?profile=free" not in source


def test_salt_house_demo_answers_its_scoped_portion_with_simulated_availability():
    source = (CAILVILLE / "salt_house_restaurant.hocon").read_text(encoding="utf-8")

    assert "A broader inquiry is relevant when you can make a partial claim" in source
    assert source.count('${instructions_prefix} ${demo_mode} """') >= 2
    assert "simulate a realistic availability result" in source
    assert "open daily from\n5:00 PM through 11:00 PM" in source
