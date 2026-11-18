"""Tests for the paper market: run with  python3 -m unittest test_sim -v"""
import unittest

import make_prices
import sim


def flat_then_jump():
    return [100.0] * 60 + [200.0] * 40


class PaperMarket(unittest.TestCase):
    def test_buy_and_hold_without_costs_is_the_price_ratio(self):
        p = make_prices.make(500, 3)
        r = sim.run_agent(lambda h, s: 1.0, p, fee_bps=0, slippage_bps=0, warmup=50)
        # the order is placed at bar 50 and fills at bar 51
        self.assertAlmostEqual(r["total_return"], p[-1] / p[51] - 1.0, places=5)

    def test_an_agent_never_sees_the_future(self):
        p = make_prices.make(300, 5)
        seen = []

        def spy(history, state):
            seen.append((state["bar"], len(history), history[-1]))
            return 0.0

        sim.run_agent(spy, p, warmup=50)
        for bar, n, last in seen:
            self.assertEqual(last, p[bar], "the newest price an agent sees is the current bar's")
            self.assertLessEqual(n, bar + 1)

    def test_the_order_fills_at_the_next_bar_not_the_one_the_agent_saw(self):
        # flat at 100, then 200. An agent that buys at bar 59 (still 100) fills at bar 60 (200), so it must NOT gain from the jump on that bar.
        p = flat_then_jump()
        r = sim.run_agent(lambda h, s: 1.0 if s["bar"] == 59 else 0.0, p, fee_bps=0, slippage_bps=0, warmup=50)
        self.assertAlmostEqual(r["total_return"], 0.0, places=6)

    def test_fees_and_slippage_cost_money(self):
        p = make_prices.make(1500, 9)
        flip = lambda h, s: 1.0 if s["bar"] % 2 == 0 else 0.0
        free = sim.run_agent(flip, p, fee_bps=0, slippage_bps=0)
        costly = sim.run_agent(flip, p, fee_bps=10, slippage_bps=5)
        self.assertLess(costly["total_return"], free["total_return"])
        self.assertGreater(costly["fees_paid"], 0)

    def test_exposure_is_capped_and_bad_answers_are_flat(self):
        p = make_prices.make(400, 2)
        r = sim.run_agent(lambda h, s: 5.0, p, fee_bps=0, slippage_bps=0, max_exposure=0.5)
        full = sim.run_agent(lambda h, s: 1.0, p, fee_bps=0, slippage_bps=0)
        self.assertNotAlmostEqual(r["total_return"], full["total_return"], places=3)
        nan = sim.run_agent(lambda h, s: float("nan"), p)
        self.assertEqual(nan["trades"], 0)
        none = sim.run_agent(lambda h, s: None, p)
        self.assertEqual(none["trades"], 0)

    def test_the_kill_switch_flattens_and_stops(self):
        p = [100.0] * 60 + [100.0 - i for i in range(1, 41)]  # a steady fall
        r = sim.run_agent(lambda h, s: 1.0, p, fee_bps=0, slippage_bps=0, warmup=50, halt_drawdown=0.2)
        self.assertTrue(r["halted"])
        self.assertLess(r["max_drawdown"], 0.45, "the loss stops growing once it halts")
        no_stop = sim.run_agent(lambda h, s: 1.0, p, fee_bps=0, slippage_bps=0, warmup=50)
        self.assertGreater(no_stop["max_drawdown"], r["max_drawdown"])

    def test_shorting_only_when_allowed(self):
        p = [100.0] * 60 + [100.0 - i for i in range(1, 41)]
        no = sim.run_agent(lambda h, s: -1.0, p, fee_bps=0, slippage_bps=0, warmup=50)
        yes = sim.run_agent(lambda h, s: -1.0, p, fee_bps=0, slippage_bps=0, warmup=50, short=True)
        self.assertEqual(no["trades"], 0)
        self.assertGreater(yes["total_return"], 0.1)

    def test_too_few_prices_is_an_error(self):
        with self.assertRaises(ValueError):
            sim.run_agent(lambda h, s: 1.0, [1.0] * 10)


if __name__ == "__main__":
    unittest.main()
