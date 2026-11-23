"""Direct-mode tests for LeagueLedger.

    env -u PYTHONPATH -u VIRTUAL_ENV -u PYTHONHOME uv run --python 3.13 \
        --with pytest --with genlayer-test pytest tests/direct -q

Scoreboard pages and the model are mocked; the contract, its consensus callback
and all of its arithmetic are real.
"""

import json
import re

CONTRACT = "contracts/league_ledger.py"
PROMPT_MARKER = "UNTRUSTED SCOREBOARD"
PAGE_MARKER = "scoreboard"

TEAMS = ["Northside", "Riverside", "Eastgate", "Harbour"]


def who(addr):
    from genlayer import Address

    return str(Address(bytes(addr))).lower()


def deploy(direct_deploy):
    return direct_deploy(CONTRACT)


def register(contract, direct_vm, sender, season_id="s1", teams=None, tie="H2H_GD_EARLIEST",
             points=(3, 1, 0), name="Autumn Cup"):
    direct_vm.sender = sender
    payload = teams if isinstance(teams, str) else json.dumps(teams or TEAMS[:3])
    return contract.register_season(
        season_id, name, payload, points[0], points[1], points[2], tie
    )


def mock_read(direct_vm, host, outcome=None, home=None, away=None, body=None):
    """Install one page and one model answer for the next consensus round."""
    direct_vm.clear_mocks()
    text = body or f"{PAGE_MARKER} for {host}: final score published here"
    direct_vm.mock_web(re.escape(f"boards.example.org/{host}"), {"status": 200, "body": text})
    if outcome is None:
        return
    direct_vm.mock_llm(
        re.escape(PAGE_MARKER), json.dumps({"outcome": outcome, "home_goals": home, "away_goals": away})
    )


def url(host):
    return f"https://boards.example.org/{host}"


def submit(contract, direct_vm, sender, match_id, host, home, away, outcome, hg, ag,
           season_id="s1"):
    mock_read(direct_vm, host, outcome, hg, ag)
    direct_vm.sender = sender
    return contract.submit_result(season_id, match_id, home, away, url(host))


class TestRegistration:
    def test_registration_is_returned_and_read_back_by_views(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        out = register(contract, direct_vm, direct_alice)

        assert out["season_id"] == "s1"
        assert out["name"] == "Autumn Cup"
        assert out["organizer"] == who(direct_alice)
        assert out["teams"] == TEAMS[:3]
        assert (out["win_points"], out["draw_points"], out["loss_points"]) == (3, 1, 0)
        assert out["tie_order"] == "H2H_GD_EARLIEST"
        assert out["status"] == "open"
        assert out["match_count"] == 0 and out["closed_at"] == 0
        assert (out["champion"], out["silver"], out["bronze"]) == ("", "", "")
        stored = contract.get_season("s1")
        assert stored["teams"] == TEAMS[:3]
        assert contract.stats() == {"seasons": 1, "results": 0}
        assert contract.results_of("s1") == []
        assert contract.medals("s1")["standings"] == []

    def test_a_season_id_can_only_be_registered_once(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        with direct_vm.expect_revert("is taken"):
            register(contract, direct_vm, direct_alice)

    def test_ids_and_names_are_bounded(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("1 to 64 characters"):
            register(contract, direct_vm, direct_alice, season_id="")
        with direct_vm.expect_revert("1 to 64 characters"):
            register(contract, direct_vm, direct_alice, season_id="x" * 65)
        with direct_vm.expect_revert("1 to 120 characters"):
            register(contract, direct_vm, direct_alice, name="")

    def test_a_season_needs_two_to_eight_distinct_teams(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("2 to 8 teams"):
            register(contract, direct_vm, direct_alice, "one", ["Only"])
        with direct_vm.expect_revert("2 to 8 teams"):
            register(contract, direct_vm, direct_alice, "many", [f"T{i}" for i in range(9)])
        with direct_vm.expect_revert("listed twice"):
            register(contract, direct_vm, direct_alice, "dup", ["A", "B", "A"])
        with direct_vm.expect_revert("1 to 120 characters"):
            register(contract, direct_vm, direct_alice, "blank", ["A", "   "])
        with direct_vm.expect_revert("JSON array"):
            register(contract, direct_vm, direct_alice, "bad", "Northside,Riverside")

    def test_points_must_be_ordered_and_bounded(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("whole numbers from 0 to 100"):
            register(contract, direct_vm, direct_alice, "p1", points=(101, 1, 0))
        with direct_vm.expect_revert("whole numbers from 0 to 100"):
            register(contract, direct_vm, direct_alice, "p2", points=("3.5", 1, 0))
        with direct_vm.expect_revert("a win must be worth more"):
            register(contract, direct_vm, direct_alice, "p3", points=(1, 1, 0))
        with direct_vm.expect_revert("a draw must be worth more"):
            register(contract, direct_vm, direct_alice, "p4", points=(3, 1, 2))
        assert register(contract, direct_vm, direct_alice, "p5", points=(6, 3, 0))["win_points"] == 6

    def test_only_the_two_documented_tie_orders_are_allowed(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        with direct_vm.expect_revert("tie order must be"):
            register(contract, direct_vm, direct_alice, tie="SECRET")
        assert register(contract, direct_vm, direct_alice, tie="GD_H2H_EARLIEST")["tie_order"] == "GD_H2H_EARLIEST"


class TestResultReading:
    def test_a_home_win_is_recorded_with_its_consensus_reading(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        out = submit(contract, direct_vm, direct_alice, "m1", "board-1", "Northside", "Riverside",
                     "HOME_WIN", 2, 0)

        assert out["match_id"] == "m1" and out["outcome"] == "HOME_WIN"
        assert (out["home_goals"], out["away_goals"]) == (2, 0)
        assert out["seq"] == 1 and out["home"] == "Northside"
        assert out["scoreboard_url"] == url("board-1")
        reading = json.loads(out["reading"])
        assert reading == {"valid": True, "outcome": "HOME_WIN", "home_goals": 2, "away_goals": 0}
        assert contract.get_result("s1", "m1")["outcome"] == "HOME_WIN"
        assert contract.get_season("s1")["match_count"] == 1
        assert len(contract.results_of("s1")) == 1
        assert contract.stats()["results"] == 1

    def test_draw_and_away_win_are_separate_buckets(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "DRAW", 1, 1)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Northside", "Eastgate", "AWAY_WIN", 0, 3)
        rows = contract.results_of("s1")
        assert [row["outcome"] for row in rows] == ["DRAW", "AWAY_WIN"]
        assert [(row["home_goals"], row["away_goals"]) for row in rows] == [(1, 1), (0, 3)]
        assert [row["seq"] for row in rows] == [1, 2]

    def test_a_malformed_model_answer_is_refused_without_storing_anything(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.clear_mocks()
        direct_vm.mock_web("boards\\.example\\.org/bad", {"status": 200, "body": "scoreboard is online"})
        direct_vm.mock_llm(re.escape(PAGE_MARKER), "not json at all")
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("usable final score"):
            contract.submit_result("s1", "bad", "Northside", "Riverside", url("bad"))
        assert contract.results_of("s1") == [] and contract.get_season("s1")["match_count"] == 0

    def test_out_of_range_goal_counts_are_refused(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        for host, hg, ag in (("o1", 100, 1), ("o2", -2, 0), ("o3", 2, 1000)):
            mock_read(direct_vm, host, "HOME_WIN" if hg > ag else "AWAY_WIN", hg, ag)
            with direct_vm.expect_revert("usable final score"):
                contract.submit_result("s1", host, "Northside", "Riverside", url(host))
        assert contract.stats()["results"] == 0

    def test_an_outcome_that_contradicts_the_goals_is_refused(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        for host, outcome in (("c1", "HOME_WIN"), ("c2", "AWAY_WIN")):
            mock_read(direct_vm, host, outcome, 1, 1)
            with direct_vm.expect_revert("usable final score"):
                contract.submit_result("s1", host, "Northside", "Riverside", url(host))

    def test_an_empty_or_unreadable_page_is_refused(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        mock_read(direct_vm, "blank", body="   ")
        with direct_vm.expect_revert("usable final score"):
            contract.submit_result("s1", "blank", "Northside", "Riverside", url("blank"))
        mock_read(direct_vm, "none", "UNREADABLE", None, None)
        with direct_vm.expect_revert("usable final score"):
            contract.submit_result("s1", "none", "Northside", "Riverside", url("none"))
        assert contract.results_of("s1") == []

    def test_a_second_result_for_the_same_match_is_refused(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 2, 0)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("already recorded"):
            submit(contract, direct_vm, direct_alice, "m1", "b2", "Northside", "Riverside", "DRAW", 1, 1)
        assert len(contract.results_of("s1")) == 1
        assert contract.get_result("s1", "m1")["outcome"] == "HOME_WIN"

    def test_a_scoreboard_url_cannot_be_counted_twice(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 2, 0)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("already used"):
            submit(contract, direct_vm, direct_alice, "m2", "b1", "Eastgate", "Northside", "DRAW", 0, 0)

    def test_unknown_seasons_teams_and_bad_urls_are_refused(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("no such season"):
            contract.submit_result("missing", "m", "A", "B", url("b1"))
        with direct_vm.expect_revert("http(s) URL"):
            contract.submit_result("s1", "m", "Northside", "Riverside", "ftp://boards/b")
        with direct_vm.expect_revert("registered in the season"):
            contract.submit_result("s1", "m", "Northside", "Strangers", url("b1"))
        with direct_vm.expect_revert("cannot play itself"):
            contract.submit_result("s1", "m", "Northside", "Northside", url("b1"))
        with direct_vm.expect_revert("1 to 64 characters"):
            contract.submit_result("s1", "", "Northside", "Riverside", url("b1"))


class TestStandingsAndClose:
    def test_standings_arithmetic_is_derived_from_results(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 3, 0)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Northside", "Eastgate", "DRAW", 2, 2)
        submit(contract, direct_vm, direct_alice, "m3", "b3", "Eastgate", "Riverside", "AWAY_WIN", 0, 1)

        table = contract.get_standings("s1")
        assert [row["team"] for row in table] == ["Northside", "Riverside", "Eastgate"]
        north = table[0]
        assert north["played"] == 2 and north["wins"] == 1 and north["draws"] == 1
        assert north["losses"] == 0 and (north["gf"], north["ga"], north["gd"]) == (5, 2, 3)
        assert north["points"] == 4 and north["rank"] == 1
        riverside = table[1]
        assert (riverside["points"], riverside["gd"], riverside["wins"]) == (3, -2, 1)
        east = table[2]
        assert (east["points"], east["gd"], east["played"]) == (1, -1, 2)

    def test_head_to_head_decides_a_tied_pair_before_goal_difference(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 1, 0)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Riverside", "Eastgate", "HOME_WIN", 5, 0)
        table = contract.get_standings("s1")
        assert [row["team"] for row in table] == ["Northside", "Riverside", "Eastgate"]
        assert table[0]["points"] == table[1]["points"] == 3
        assert table[0]["gd"] < table[1]["gd"]

    def test_gd_first_order_reverses_the_same_tied_pair(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, tie="GD_H2H_EARLIEST")
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 1, 0)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Riverside", "Eastgate", "HOME_WIN", 5, 0)
        table = contract.get_standings("s1")
        assert [row["team"] for row in table] == ["Riverside", "Northside", "Eastgate"]

    def test_when_head_to_head_and_goal_difference_tie_first_recorded_wins(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, teams=["Northside", "Riverside", "Eastgate", "Harbour"])
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Eastgate", "HOME_WIN", 1, 0)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Riverside", "Harbour", "HOME_WIN", 1, 0)
        table = contract.get_standings("s1")
        assert [row["team"] for row in table[:2]] == ["Northside", "Riverside"]
        assert table[0]["points"] == table[1]["points"] == 3
        assert table[0]["gd"] == table[1]["gd"] == 1

    def test_closing_writes_champion_and_medals_and_freezes_the_season(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 4, 0)
        submit(contract, direct_vm, direct_alice, "m2", "b2", "Riverside", "Eastgate", "DRAW", 1, 1)
        out = contract.close_season("s1")

        assert out["status"] == "closed"
        assert (out["champion"], out["silver"], out["bronze"]) == ("Northside", "Eastgate", "Riverside")
        assert [row["team"] for row in out["standings"]] == ["Northside", "Eastgate", "Riverside"]
        season = contract.get_season("s1")
        assert season["status"] == "closed" and season["closed_at"] > 0
        assert season["champion"] == "Northside" and season["bronze"] == "Riverside"
        assert contract.medals("s1")["champion"] == "Northside"

        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("already closed"):
            contract.close_season("s1")
        with direct_vm.expect_revert("closed"):
            submit(contract, direct_vm, direct_alice, "m3", "b3", "Northside", "Eastgate", "DRAW", 0, 0)

    def test_only_the_organizer_closes_and_an_empty_season_cannot_close(self, direct_deploy, direct_vm,
                                                                         direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("only the organizer"):
            contract.close_season("s1")
        direct_vm.sender = direct_alice
        with direct_vm.expect_revert("at least one recorded result"):
            contract.close_season("s1")

    def test_views_list_seasons_results_and_medals_before_close(self, direct_deploy, direct_vm,
                                                                 direct_alice, direct_bob):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "alpha")
        register(contract, direct_vm, direct_bob, "beta", teams=TEAMS)
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "AWAY_WIN", 0, 2, "alpha")
        assert [s["season_id"] for s in contract.list_seasons()] == ["alpha", "beta"]
        assert contract.get_result("alpha", "m1")["away_goals"] == 2
        assert len(contract.results_of("beta")) == 0
        assert contract.medals("alpha") == {
            "season_id": "alpha", "status": "open", "champion": "", "silver": "",
            "bronze": "", "standings": [],
        }
        with direct_vm.expect_revert("no such result"):
            contract.get_result("alpha", "missing")

    def test_sequence_numbers_never_restart_across_seasons(self, direct_deploy, direct_vm, direct_alice):
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice, "alpha")
        register(contract, direct_vm, direct_alice, "beta")
        submit(contract, direct_vm, direct_alice, "m1", "b1", "Northside", "Riverside", "HOME_WIN", 1, 0, "alpha")
        submit(contract, direct_vm, direct_alice, "m1", "b2", "Northside", "Riverside", "DRAW", 1, 1, "beta")
        assert contract.get_result("alpha", "m1")["seq"] == 1
        assert contract.get_result("beta", "m1")["seq"] == 2

    def test_the_validator_fetches_the_page_inside_the_callback(self, direct_deploy, direct_vm, direct_alice):
        """A validator must read the page itself, not vote on the leader's copy."""
        contract = deploy(direct_deploy)
        register(contract, direct_vm, direct_alice)
        target = url("live")
        hits = []

        def live_web(request):
            hits.append(request["url"])
            return {"ok": {"response": {"status": 200, "body": f"{PAGE_MARKER}: final score 2-0"}}}

        direct_vm.clear_mocks()
        direct_vm._live_web_handler = live_web
        direct_vm.mock_llm(re.escape(PAGE_MARKER), json.dumps({"outcome": "HOME_WIN", "home_goals": 2, "away_goals": 0}))
        direct_vm.sender = direct_alice
        contract.submit_result("s1", "m1", "Northside", "Riverside", target)
        assert hits == [target]

        direct_vm._gl_call_hook = lambda vm, request: (
            {"ok": True} if "ExecPromptTemplate" in request else None
        )
        assert direct_vm.run_validator() is True
        assert hits == [target, target]
