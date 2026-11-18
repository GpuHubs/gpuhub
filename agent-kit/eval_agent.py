#!/usr/bin/env python3
"""Tests an agent on hundreds of synthetic markets, spread over rented GPUhub machines, and prints how it did across all of them.

One lucky run proves nothing. This shows the spread: the typical result, the bad ones, how often the agent beat simply holding,
and whether the kill switch fired.

    export GPUHUB_KEY=...
    python3 eval_agent.py --agent agent_example.py --dry-run          # machines and the worst-case cost, rents nothing
    python3 eval_agent.py --agent agent_example.py --markets 200      # test on 200 markets

Try an agent on your own computer first with sim.py. This is a testing tool, not advice.
"""
import argparse
import json
import os
import sys

from distributed import run_chunks
from gpuhub import Client
from sweep import add_common_args, guard, split, MAX_MACHINES

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["sim.py", "make_prices.py", "run_eval.py"]


def pct(sorted_values, p):
    """The p-th percentile (0-100) of a sorted list, by nearest rank."""
    if not sorted_values:
        return 0.0
    k = max(0, min(len(sorted_values) - 1, int(round(p / 100.0 * (len(sorted_values) - 1)))))
    return sorted_values[k]


def summarize(results):
    """results: a list of {"seed", "agent", "hold"} records. Returns numbers describing the spread."""
    results = sorted(results, key=lambda r: r["seed"])
    a = sorted(r["agent"]["total_return"] for r in results)
    h = sorted(r["hold"]["total_return"] for r in results)
    n = len(results)
    return {
        "markets": n,
        "agent_median_return": pct(a, 50),
        "agent_mean_return": sum(a) / n,
        "agent_p5_return": pct(a, 5),
        "agent_worst_return": a[0],
        "agent_mean_drawdown": sum(r["agent"]["max_drawdown"] for r in results) / n,
        "agent_worst_drawdown": max(r["agent"]["max_drawdown"] for r in results),
        "agent_profitable_share": sum(1 for x in a if x > 0) / n,
        "agent_beat_hold_share": sum(1 for r in results if r["agent"]["total_return"] > r["hold"]["total_return"]) / n,
        "agent_mean_trades": sum(r["agent"]["trades"] for r in results) / n,
        "agent_halted": sum(1 for r in results if r["agent"]["halted"]),
        "hold_median_return": pct(h, 50),
        "hold_mean_return": sum(h) / n,
        "hold_p5_return": pct(h, 5),
        "hold_worst_drawdown": max(r["hold"]["max_drawdown"] for r in results),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Test an agent on many synthetic markets on rented machines.")
    add_common_args(ap)
    ap.add_argument("--agent", required=True, help="a Python file that defines agent(history, state)")
    ap.add_argument("--markets", type=int, default=100, help="how many synthetic markets")
    ap.add_argument("--first-seed", type=int, default=1)
    ap.add_argument("--bars", type=int, default=5000, help="bars per market")
    ap.add_argument("--fee-bps", type=float, default=5.0)
    ap.add_argument("--slippage-bps", type=float, default=2.0)
    ap.add_argument("--short", action="store_true", help="let the agent go short")
    ap.add_argument("--halt-drawdown", type=float, default=None, help="kill switch drawdown, e.g. 0.2")
    ap.add_argument("--out", default="eval_results.json")
    a = ap.parse_args(argv)

    machines = max(1, min(a.machines, MAX_MACHINES))
    gh = Client(a.key or "dry", a.api) if a.dry_run else Client(a.key, a.api)
    code = guard(gh, machines, a.max_hourly_usd, a.deadline_sec, a.max_spend_usd, a.dry_run)
    if code is not None:
        return code

    cfg = {"bars": a.bars, "fee_bps": a.fee_bps, "slippage_bps": a.slippage_bps, "short": a.short, "halt_drawdown": a.halt_drawdown}
    seeds = list(range(a.first_seed, a.first_seed + a.markets))
    chunks = split(seeds, machines * 2)
    files = {"config.json": json.dumps(cfg).encode()}
    for n in FILES:
        with open(os.path.join(HERE, n), "rb") as f:
            files[n] = f.read()
    with open(a.agent, "rb") as f:
        files["agent.py"] = f.read()

    outcome = run_chunks(
        gh, chunks, files,
        command=lambda i: "%s run_eval.py agent.py config.json chunk_%d.json result_%d.json" % (a.python, i, i),
        machines=machines, max_hourly_usd=a.max_hourly_usd, image=a.image, deadline_sec=a.deadline_sec,
        validate=lambda chunk, got: len(got) == len(chunk),
    )
    results = [r for i in sorted(outcome.results) for r in outcome.results[i]]
    print("\n%d machines used, %d of %d markets done in %.1fs, billed $%.4f" % (outcome.machines, len(results), len(seeds), outcome.seconds, outcome.billed))
    if results:
        s = summarize(results)
        with open(a.out, "w") as f:
            json.dump({"config": cfg, "summary": s, "results": sorted(results, key=lambda r: r["seed"])}, f)
        print("\n                         agent      buy and hold")
        print("median return          %+8.2f%%      %+8.2f%%" % (s["agent_median_return"] * 100, s["hold_median_return"] * 100))
        print("mean return            %+8.2f%%      %+8.2f%%" % (s["agent_mean_return"] * 100, s["hold_mean_return"] * 100))
        print("worst 5%% of markets    %+8.2f%%      %+8.2f%%" % (s["agent_p5_return"] * 100, s["hold_p5_return"] * 100))
        print("worst drawdown         %8.1f%%      %8.1f%%" % (s["agent_worst_drawdown"] * 100, s["hold_worst_drawdown"] * 100))
        print("profitable in          %8.0f%% of markets" % (s["agent_profitable_share"] * 100))
        print("beat buy and hold in   %8.0f%% of markets" % (s["agent_beat_hold_share"] * 100))
        print("kill switch fired in   %8d markets, average %.0f trades per market" % (s["agent_halted"], s["agent_mean_trades"]))
        print("full results are in %s. These markets are synthetic and a paper result says little about real ones: a testing tool, not advice." % a.out)
    if outcome.missing:
        print("not done: chunks %s (their machine failed or the deadline came). Sessions are stopped." % outcome.missing)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
