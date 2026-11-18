"""Runs on the rented machine: tests an agent on a chunk of synthetic markets.

    python3 run_eval.py agent.py config.json chunk_0.json result_0.json
"""
import json
import sys

import make_prices
import sim


def evaluate(agent, seeds, cfg):
    kw = dict(fee_bps=cfg["fee_bps"], slippage_bps=cfg["slippage_bps"], short=cfg["short"], halt_drawdown=cfg["halt_drawdown"])
    out = []
    for s in seeds:
        prices = make_prices.make(cfg["bars"], s)
        out.append({"seed": s, "agent": sim.run_agent(agent, prices, **kw), "hold": sim.buy_and_hold(prices, **kw)})
    return out


def main():
    agent_path, config_path, chunk_path, out_path = sys.argv[1:5]
    with open(config_path) as f:
        cfg = json.load(f)
    with open(chunk_path) as f:
        seeds = json.load(f)
    results = evaluate(sim.load_agent(agent_path), seeds, cfg)
    with open(out_path, "w") as f:
        json.dump(results, f)
    print("ok %d" % len(results))


if __name__ == "__main__":
    main()
