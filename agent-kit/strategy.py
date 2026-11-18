"""An example strategy to test: a moving-average crossover with an optional stop loss.

Pure Python, so it runs on any rented machine. Replace backtest() with your own logic: it takes a list of prices and parameters
and returns a dict of numbers. Nothing here is advice: an example only. A backtest shows how a rule would have done on past data,
which says little about the future, and a parameter sweep is easy to overfit.
"""
import math


def backtest(prices, fast, slow, stop=None):
    """Long when the fast average is above the slow one, flat otherwise. `stop` is a loss, e.g. 0.05 exits after a 5% drop from entry."""
    n = len(prices)
    if fast >= slow or n <= slow + 1:
        return {"fast": fast, "slow": slow, "stop": stop, "total_return": 0.0, "max_drawdown": 0.0, "trades": 0, "score": -9.0}
    csum = [0.0]
    for p in prices:
        csum.append(csum[-1] + p)

    def sma(i, w):
        return (csum[i + 1] - csum[i + 1 - w]) / w

    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    in_pos = False
    entry = 0.0
    trades = 0
    rets = []
    for i in range(slow, n - 1):
        want = sma(i, fast) > sma(i, slow)
        if in_pos and stop is not None and prices[i] <= entry * (1.0 - stop):
            want = False
        if want and not in_pos:
            in_pos, entry = True, prices[i]
            trades += 1
        elif not want and in_pos:
            in_pos = False
        r = (prices[i + 1] / prices[i] - 1.0) if in_pos else 0.0
        rets.append(r)
        equity *= 1.0 + r
        peak = max(peak, equity)
        max_dd = max(max_dd, 1.0 - equity / peak)
    mean = sum(rets) / len(rets)
    var = sum((x - mean) ** 2 for x in rets) / len(rets)
    sharpe = (mean / math.sqrt(var)) * math.sqrt(252) if var > 0 else 0.0
    return {
        "fast": fast,
        "slow": slow,
        "stop": stop,
        "total_return": round(equity - 1.0, 6),
        "max_drawdown": round(max_dd, 6),
        "trades": trades,
        "score": round(sharpe, 6),
    }
