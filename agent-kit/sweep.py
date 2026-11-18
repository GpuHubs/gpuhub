#!/usr/bin/env python3
"""Spreads a parameter sweep over rented GPUhub machines and merges the results.

Your agent (this script) stays on your computer, with your keys and your rules. Only code and prices go to the rented machines.
Each machine runs part of the grid, you download its results, and every session is stopped, whatever happens.

    export GPUHUB_KEY=...                       # your API key: a signed spending limit, from https://gpuhub.app/rent
    python3 sweep.py --dry-run                  # see the machines and the most this could cost, rents nothing
    python3 sweep.py --machines 4               # run the example sweep on 4 machines

See README.md for how to use your own strategy and data.
"""
import argparse
import json
import os
import sys

import make_prices
from distributed import run_chunks
from gpuhub import Client

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["strategy.py", "run_chunk.py"]  # what the machine needs besides the prices and its chunk
MAX_MACHINES = 8  # the most sessions one key can have at once


def example_grid():
    grid = []
    for fast in range(5, 60, 5):
        for slow in range(20, 200, 10):
            if fast >= slow:
                continue
            for stop in (None, 0.01, 0.02, 0.05):
                grid.append({"fast": fast, "slow": slow, "stop": stop})
    return grid


def rank_key(r):
    """Best first. Equal scores are told apart by return and then by the parameters, so the order never depends on which machine answered first."""
    return (-r["score"], -r["total_return"], r["fast"], r["slow"], -1.0 if r["stop"] is None else r["stop"])


def split(items, parts):
    parts = max(1, min(parts, len(items)))
    return [items[i::parts] for i in range(parts)]


def guard(gh, machines, max_hourly_usd, deadline_sec, max_spend_usd, dry_run):
    """Prints what is free and the worst case cost. Returns an exit code to stop with, or None to go on."""
    worst = machines * max_hourly_usd * deadline_sec / 3600.0
    free = [m for m in gh.machines() if m.get("available") and m.get("kind") == "container"]
    free.sort(key=lambda m: int(m["effectiveHourlyUnits"]))
    cheap = [m for m in free if int(m["effectiveHourlyUnits"]) / 1e6 <= max_hourly_usd]
    print("%d machines are free, %d within $%.3f an hour" % (len(free), len(cheap), max_hourly_usd))
    for m in cheap[:machines]:
        gpu = m["specs"].get("gpu")
        print("  %s  %s  $%.4f/h" % (m["id"][:10], ("%s %sGB" % (gpu["name"], gpu["vramGb"])) if gpu else "CPU only", int(m["effectiveHourlyUnits"]) / 1e6))
    print("worst case if everything runs until the deadline: $%.4f" % worst)
    if dry_run:
        return 0
    if worst > max_spend_usd:
        print("refusing: the worst case $%.4f is above --max-spend-usd %.2f. Lower --machines, --deadline-sec or --max-hourly-usd, or raise the cap." % (worst, max_spend_usd))
        return 1
    if not cheap:
        print("no free machine within the price limit; try again in a moment or raise --max-hourly-usd")
        return 1
    return None


def add_common_args(ap):
    """The options every kit script shares: where to connect, how much to spend, which machines."""
    ap.add_argument("--api", default=os.environ.get("GPUHUB_API", "https://gpuhub.app"), help="GPUhub address")
    ap.add_argument("--key", default=os.environ.get("GPUHUB_KEY", ""), help="API key (or set GPUHUB_KEY)")
    ap.add_argument("--machines", type=int, default=4, help="how many machines to rent (1-%d)" % MAX_MACHINES)
    ap.add_argument("--max-hourly-usd", type=float, default=0.5, help="refuse machines dearer than this per hour")
    ap.add_argument("--max-spend-usd", type=float, default=1.0, help="refuse to start if the worst case could cost more than this")
    ap.add_argument("--deadline-sec", type=int, default=900, help="stop everything after this long")
    ap.add_argument("--image", default="python:3.12-slim", help="container image of the workspace")
    ap.add_argument("--python", default="python3", help="the python command inside the workspace")
    ap.add_argument("--dry-run", action="store_true", help="show machines and the worst-case cost, rent nothing")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run a parameter sweep on rented GPUhub machines.")
    add_common_args(ap)
    ap.add_argument("--prices", help="a prices.csv, one price per line (default: a synthetic series)")
    ap.add_argument("--bars", type=int, default=20000, help="length of the synthetic series")
    ap.add_argument("--grid", help="a JSON file with a list of parameter sets (default: the example grid)")
    ap.add_argument("--top", type=int, default=10, help="how many best results to print")
    ap.add_argument("--out", default="results.json", help="where to write all results")
    a = ap.parse_args(argv)

    machines = max(1, min(a.machines, MAX_MACHINES))
    gh = Client(a.key or "dry", a.api) if a.dry_run else Client(a.key, a.api)
    code = guard(gh, machines, a.max_hourly_usd, a.deadline_sec, a.max_spend_usd, a.dry_run)
    if code is not None:
        return code

    if a.prices:
        with open(a.prices, "rb") as f:
            prices_bytes = f.read()
    else:
        prices_bytes = ("\n".join(str(p) for p in make_prices.make(a.bars)) + "\n").encode()
    if a.grid:
        with open(a.grid) as f:
            grid = json.load(f)
    else:
        grid = example_grid()
    chunks = split(grid, machines * 2)  # more chunks than machines, so a fast machine takes more
    files = {"prices.csv": prices_bytes}
    for n in FILES:
        with open(os.path.join(HERE, n), "rb") as f:
            files[n] = f.read()

    outcome = run_chunks(
        gh, chunks, files,
        command=lambda i: "%s run_chunk.py prices.csv chunk_%d.json result_%d.json" % (a.python, i, i),
        machines=machines, max_hourly_usd=a.max_hourly_usd, image=a.image, deadline_sec=a.deadline_sec,
        validate=lambda chunk, got: len(got) == len(chunk),
    )

    merged = [r for i in sorted(outcome.results) for r in outcome.results[i]]
    print("\n%d machines used, %d of %d parameter sets done in %.1fs, billed $%.4f" % (outcome.machines, len(merged), len(grid), outcome.seconds, outcome.billed))
    if merged:
        merged.sort(key=rank_key)
        with open(a.out, "w") as f:
            json.dump(merged, f)
        print("all results are in %s. Best %d by score:" % (a.out, min(a.top, len(merged))))
        for r in merged[: a.top]:
            print("  fast %-3d slow %-3d stop %-5s  return %+.2f%%  drawdown %.1f%%  trades %-4d score %.2f" % (r["fast"], r["slow"], r["stop"], r["total_return"] * 100, r["max_drawdown"] * 100, r["trades"], r["score"]))
        print("a backtest on past data says little about the future; this is an example, not advice")
    if outcome.missing:
        print("not done: chunks %s (their machine failed or the deadline came). Sessions are stopped." % outcome.missing)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
