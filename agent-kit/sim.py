"""A paper market for testing a trading agent without real money. Pure Python, runs on your computer or on a rented machine.

An agent is a function:

    def agent(history, state):
        # history: the last prices, newest last (it never includes the future)
        # state:   {"bar", "cash", "units", "equity", "exposure", "drawdown"}
        return 0.5      # the share of your equity to hold in the asset, from 0 (flat) to 1 (all in); -1 to 1 if short=True

The order is placed at the end of the bar the agent saw and fills at the NEXT bar's price, worse by the slippage and with the fee
taken, so an agent can't profit from looking ahead. The broker also holds the safety rails a real agent should have: a cap on
the exposure, and a kill switch that flattens everything and stops trading when the drawdown gets too deep.

Try one agent on your computer:    python3 sim.py --agent agent_example.py
Test it on hundreds of markets:    python3 eval_agent.py --agent agent_example.py --markets 200 --machines 4

This is a testing tool, not advice. A paper result says little about real markets, and it is easy to overfit.
"""
import argparse
import importlib.util
import math
import os
import sys


def load_agent(path):
    """Loads `agent` from a Python file."""
    spec = importlib.util.spec_from_file_location("user_agent", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not callable(getattr(mod, "agent", None)):
        raise SystemExit("%s must define agent(history, state)" % path)
    return mod.agent


def run_agent(agent, prices, fee_bps=5.0, slippage_bps=2.0, start_cash=10000.0, warmup=50, lookback=500,
              short=False, max_exposure=1.0, halt_drawdown=None, band=0.01, curve=False):
    n = len(prices)
    if n < warmup + 3:
        raise ValueError("need at least %d prices" % (warmup + 3))
    fee = fee_bps / 1e4
    slip = slippage_bps / 1e4
    cash, units = start_cash, 0.0
    peak = start_cash
    max_dd = 0.0
    trades = 0
    traded = 0.0
    fees_paid = 0.0
    halted = False
    rets = []
    eq = []
    prev_equity = start_cash
    lo = -max_exposure if short else 0.0
    for i in range(warmup, n - 1):
        price = prices[i]
        equity = cash + units * price
        peak = max(peak, equity)
        drawdown = 1.0 - equity / peak if peak > 0 else 0.0
        max_dd = max(max_dd, drawdown)
        if curve:
            eq.append(equity)
        rets.append(equity / prev_equity - 1.0 if prev_equity else 0.0)
        prev_equity = equity
        if halt_drawdown is not None and drawdown >= halt_drawdown:
            halted = True
        if halted:
            target = 0.0  # the kill switch: flat, and no more trading
        else:
            state = {"bar": i, "cash": cash, "units": units, "equity": equity, "exposure": (units * price / equity) if equity else 0.0, "drawdown": drawdown}
            t = agent(prices[max(0, i + 1 - lookback): i + 1], state)
            target = 0.0 if t is None or t != t else max(lo, min(max_exposure, float(t)))
        fill = prices[i + 1]
        cur = (units * price / equity) if equity else 0.0
        # a small drift from the target is left alone, as a real agent would: no rebalancing (and no fees) every bar. A kill switch ignores the band.
        if not halted and abs(target - cur) <= band:
            target = cur
        want_units = target * equity / fill if target != cur else units
        delta = want_units - units
        if abs(delta) * fill > 1e-9 * max(equity, 1.0):
            px = fill * (1.0 + slip) if delta > 0 else fill * (1.0 - slip)
            notional = abs(delta) * px
            cash -= delta * px
            cash -= notional * fee
            fees_paid += notional * fee
            units = want_units
            trades += 1
            traded += notional
    final = cash + units * prices[-1]
    peak = max(peak, final)
    max_dd = max(max_dd, 1.0 - final / peak if peak > 0 else 0.0)
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((x - mean) ** 2 for x in rets) / len(rets)
        sharpe = (mean / math.sqrt(var)) * math.sqrt(252) if var > 0 else 0.0
    else:
        sharpe = 0.0
    out = {
        "total_return": round(final / start_cash - 1.0, 6),
        "max_drawdown": round(max_dd, 6),
        "trades": trades,
        "turnover": round(traded / start_cash, 4),
        "fees_paid": round(fees_paid, 4),
        "sharpe": round(sharpe, 6),
        "halted": halted,
    }
    if curve:
        eq.append(final)
        out["curve"] = eq
    return out


def buy_and_hold(prices, **kw):
    """The yardstick: hold the asset the whole time, with the same fees."""
    return run_agent(lambda h, s: 1.0, prices, **kw)


def main(argv=None):
    import make_prices
    ap = argparse.ArgumentParser(description="Run one agent on a paper market, on this computer.")
    ap.add_argument("--agent", required=True, help="a Python file that defines agent(history, state)")
    ap.add_argument("--prices", help="a prices.csv, one price per line (default: a synthetic series)")
    ap.add_argument("--bars", type=int, default=5000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--fee-bps", type=float, default=5.0)
    ap.add_argument("--slippage-bps", type=float, default=2.0)
    ap.add_argument("--short", action="store_true", help="let the agent go short (exposure from -1 to 1)")
    ap.add_argument("--halt-drawdown", type=float, default=None, help="kill switch: flatten and stop trading at this drawdown, e.g. 0.2")
    a = ap.parse_args(argv)
    if a.prices:
        with open(a.prices) as f:
            prices = [float(x) for x in f if x.strip()]
    else:
        prices = make_prices.make(a.bars, a.seed)
    kw = dict(fee_bps=a.fee_bps, slippage_bps=a.slippage_bps, short=a.short, halt_drawdown=a.halt_drawdown)
    r = run_agent(load_agent(a.agent), prices, **kw)
    b = buy_and_hold(prices, **kw)
    print("agent         return %+.2f%%  drawdown %.1f%%  trades %d  fees %.2f  sharpe %.2f%s" % (r["total_return"] * 100, r["max_drawdown"] * 100, r["trades"], r["fees_paid"], r["sharpe"], "  HALTED by the kill switch" if r["halted"] else ""))
    print("buy and hold  return %+.2f%%  drawdown %.1f%%" % (b["total_return"] * 100, b["max_drawdown"] * 100))
    print("a paper result says little about real markets; this is a testing tool, not advice")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
