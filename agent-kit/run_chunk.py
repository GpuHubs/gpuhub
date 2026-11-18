"""Runs on the rented machine: backtests one chunk of the parameter grid.

    python3 run_chunk.py prices.csv chunk_0.json result_0.json
"""
import json
import sys

from strategy import backtest


def main():
    prices_path, chunk_path, out_path = sys.argv[1:4]
    with open(prices_path) as f:
        prices = [float(line) for line in f if line.strip()]
    with open(chunk_path) as f:
        grid = json.load(f)
    results = [backtest(prices, p["fast"], p["slow"], p.get("stop")) for p in grid]
    with open(out_path, "w") as f:
        json.dump(results, f)
    print("ok %d" % len(results))


if __name__ == "__main__":
    main()
