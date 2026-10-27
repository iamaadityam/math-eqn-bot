import unittest
from engine import Player, arena, resolve_volley, compile_equation, _path

class EngineTests(unittest.TestCase):
    def test_sixty_players_make_six_ten_player_arenas(self):
        players = [Player(str(i), f"team-{i}") for i in range(60)]
        groups = [players[i:i + 10] for i in range(0, 60, 10)]
        self.assertEqual([len(arena(g)) for g in groups], [10] * 6)

    def test_loser_is_not_zero(self):
        ps = arena([Player(str(i), str(i)) for i in range(10)])
        result = resolve_volley(ps, {p.id: "0" for p in ps})
        self.assertTrue(all(p["score"] >= 25 for p in result["players"]))

    def test_dead_shooter_cannot_hit_later(self):
        # Event ordering is the invariant: an owner's later beam collision is discarded after death.
        ps = arena([Player("a", "a"), Player("b", "b"), Player("c", "c")])
        result = resolve_volley(ps, {"a": "0", "b": "sin(x)", "c": "0"})
        for event in result["deaths"]:
            earlier = [e for e in result["deaths"] if e["target"] == event["shooter"] and e["time"] < event["time"]]
            self.assertFalse(earlier, "a killed cannon cannot retain later hits")

    def test_parser_has_no_eval_surface(self):
        self.assertAlmostEqual(compile_equation("sin(x)+2")(0), 2)
        with self.assertRaises(ValueError):
            compile_equation("__import__('os')")

    def test_implicit_multiplication(self):
        f = compile_equation("2x+3")
        self.assertAlmostEqual(f(4), 11.0)
        f2 = compile_equation("3sin(x)")
        self.assertAlmostEqual(f2(0), 0.0)

    def test_division_by_zero_fails_safely_without_crashing_match(self):
        # 1/x should safely produce a straight shot fallback or terminate without crash
        ps = arena([Player("1", "team-1"), Player("2", "team-2")])
        result = resolve_volley(ps, {"1": "1/x", "2": "0"})
        self.assertEqual(len(result["players"]), 2)
        self.assertTrue("1" in result["beams"])

    def test_undefined_mid_path_terminates_safely(self):
        # 1/(x-1) is undefined at x=1, path should terminate safely
        p = Player("1", "test")
        path = _path(p, "1/(x-1)")
        self.assertTrue(len(path) >= 1)

    def test_complex_numbers_handled_safely(self):
        with self.assertRaises(ValueError):
            compile_equation("(-1)^0.5")(0)

if __name__ == "__main__":
    unittest.main()
