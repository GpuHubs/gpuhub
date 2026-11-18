"""Makes a SYNTHETIC price series, so the example runs with no data and no internet. Swap in your own prices.csv (one price per line).

    python3 make_prices.py prices.csv 20000
"""
import math
import random
import sys

SCENARIOS = ("mixed", "bull", "bear", "range", "crash", "highvol")


def make(n=20000, seed=7, scenario="mixed"):
    """scenario: mixed (a new trend every 2000 bars), bull, bear, range (pulled back to 100), crash (a long rise, then a sudden fall), highvol."""
    if scenario != "mixed":
        return _scenario(n, seed, scenario)
    rnd = random.Random(seed)
    price, drift, out = 100.0, 0.0, []
    for i in range(n):
        if i % 2000 == 0:  # a new "regime" every 2000 bars
            drift = rnd.uniform(-0.0004, 0.0006)
        price *= 1.0 + drift + rnd.gauss(0.0, 0.006)
        out.append(round(price, 4))
    return out


def _scenario(n, seed, scenario):
    if scenario not in SCENARIOS:
        raise ValueError("unknown scenario %r, use one of %s" % (scenario, ", ".join(SCENARIOS)))
    rnd = random.Random("%s-%s" % (scenario, seed))
    out, price = [], 100.0
    x = 0.0  # log distance from 100, for the range scenario
    for i in range(n):
        if scenario == "bull":
            price *= 1.0 + 0.0004 + rnd.gauss(0.0, 0.006)
        elif scenario == "bear":
            price *= 1.0 - 0.0004 + rnd.gauss(0.0, 0.006)
        elif scenario == "highvol":
            price *= 1.0 + rnd.gauss(0.0, 0.016)
        elif scenario == "range":
            x += -0.03 * x + rnd.gauss(0.0, 0.009)
            price = 100.0 * math.exp(x)
        else:  # crash
            at = int(n * 0.7)
            if i < at:
                price *= 1.0 + 0.0005 + rnd.gauss(0.0, 0.005)
            elif i < at + 30:
                price *= 1.0 - 0.012 + rnd.gauss(0.0, 0.01)   # about -30% in 30 bars
            else:
                price *= 1.0 + rnd.gauss(0.0, 0.012)
        price = max(price, 0.01)
        out.append(round(price, 4))
    return out


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "prices.csv"
    bars = int(sys.argv[2]) if len(sys.argv) > 2 else 20000
    with open(path, "w") as f:
        f.write("\n".join(str(p) for p in make(bars)) + "\n")
    print("wrote %d synthetic prices to %s" % (bars, path))
