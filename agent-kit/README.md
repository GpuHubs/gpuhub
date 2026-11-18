# GPUhub agent kit

A small starting point for an AI agent that needs compute: your agent stays on your computer, and when it needs a lot of compute for a short time it rents machines on [GPUhub](https://gpuhub.app) by the second.

The example spreads a parameter sweep (a moving-average strategy tested on a price series) over several rented machines, collects the results and stops every session. Swap in your own strategy and data.

## The split that keeps your keys safe

| Stays on your computer | Goes to a rented machine |
| --- | --- |
| API keys, exchange keys, wallet keys | Code and data you are happy for the machine's owner to read |
| The agent's decisions and any orders | One chunk of the work, and the results coming back |

A machine's owner can read what runs on it, and a workspace has no internet. So never put a key in a workspace, and keep anything that places an order on your side. Rented machines are for crunching.

## Quick start

You need Python 3.8+ and a GPUhub API key (a spending limit your wallet signs, from <https://gpuhub.app/rent>).

```
export GPUHUB_KEY=...                 # on Windows PowerShell: $env:GPUHUB_KEY="..."
python3 sweep.py --dry-run            # lists free machines and the worst case cost, rents nothing
python3 sweep.py --machines 4         # runs the example sweep on 4 machines
```

The kit refuses to start if the worst case could cost more than `--max-spend-usd` (default $1): it assumes every machine runs until `--deadline-sec` (default 15 minutes) at the most per hour you allow with `--max-hourly-usd`. Everything is stopped when the work is done, when the deadline comes, on an error, and on Ctrl+C.

Example output:

```
3 machines are free, 3 within $1.000 an hour
worst case if everything runs until the deadline: $0.7500
machine 0: rented 0x4f2a91c0
...
3 machines used, 712 of 712 parameter sets done in 9.8s, billed $0.0050
all results are in results.json. Best 10 by score:
  fast 30  slow 40  stop 0.05   return +78.55%  drawdown 9.7%  trades 46  score 0.78
```

(The numbers above come from a synthetic price series made for the example. They mean nothing.)

## Use your own strategy and data

1. Put your logic in `strategy.py`: `backtest(prices, ...)` takes the prices and parameters and returns a dict with at least `fast`, `slow`, `stop`, `total_return`, `max_drawdown`, `trades` and `score`. Keep `score` as the number to rank by.
2. Your prices go in a file with one price per line: `--prices my_prices.csv`.
3. Your parameter sets go in a JSON list: `--grid my_grid.json`, for example `[{"fast": 10, "slow": 50, "stop": 0.02}, ...]`.
4. Need a library such as numpy or PyTorch? Use an image that has it: `--image pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime` (that one needs a machine with a GPU). The workspace has no internet, so you can't `pip install` inside it.

To use a GPU for model training or inference, rent with `gh.rent(gpu=True, min_vram_gb=12, image="pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime")` and run your own script, as `sweep.py` does.

## Build and test your own agent

GPUhub is a place to build, test and train agents, not to run them with real money. Orders and keys stay on your computer.

**Test without real money.** `sim.py` replays an agent over a price series with fees and slippage, and `eval_agent.py` spreads many such runs (different price series and seeds) over rented machines and prints a summary next to buy-and-hold.

```
python3 sim.py --agent agent_example.py            # one local run
python3 eval_agent.py --agent agent_example.py --machines 4 --dry-run
```

`make_prices.make(n, seed, scenario)` can make bull, bear, range, crash and wild markets too. The site's Build page builds an agent from rules and gives you an `agent.py` that runs here unchanged.

An agent is a file with `agent(history, state)` that returns the share of equity to hold (0 to 1, or -1 to 1 with `--short`). `agent_example.py` shows the shape. The simulator only models fees and slippage you set, so a good result here is a hypothesis, not a promise.

**Train a model.** `train_model.py` is a PyTorch template and `train_remote.py` runs it as a background job on a GPU machine, streams the log and downloads the result. Use an image that has PyTorch.

**Long jobs.** In your own code:

```python
with gh.rent(gpu=True, image="pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime") as ws:
    ws.upload("train.py", open("train.py", "rb").read())
    ws.start("python train.py", name="train")      # returns at once
    ws.wait("train", timeout=3600, on_log=print)   # follows the log
    ws.save("checkpoint.tar", ["out"])             # keep files on your side
# later, in a new session:  ws.restore("checkpoint.tar")
```

`save` and `restore` move your workspace files to a local archive and back, so a new session can continue where the last stopped. The workspace itself is deleted with the session.

The client keeps under 100 requests a minute and retries on 429 and 502 by itself.

## Images with libraries

A workspace has no internet. `images/` has two Dockerfiles with the usual libraries (numpy, pandas, scikit-learn; and PyTorch with transformers). They are not published yet, see `images/README.md`. Until then use `python:3.12-slim` and upload pure-Python libraries with your code.

## Files

- `gpuhub.py`: a small client for the GPUhub API (standard library only). `with gh.rent(...) as ws:` always stops the session.
- `sweep.py`: your agent's side: rents machines, sends work, merges results, stops everything.
- `distributed.py`: the generic "split work into chunks over machines" helper.
- `run_chunk.py` and `strategy.py`: what runs on the machine.
- `sim.py`, `agent_example.py`, `eval_agent.py`, `run_eval.py`: the simulator and the evaluation template.
- `train_model.py`, `train_remote.py`: the training template.
- `make_prices.py`: makes the synthetic example prices.

## Please keep in mind

- A backtest shows how a rule would have done on past data. It says little about the future, and a sweep over many parameters is easy to overfit. This kit is an example of how to use compute, not advice and not a promise of any result.
- Time on a machine is billed by the second, and a session stopped in the first minute is billed that minute.
- If a machine goes offline you are not billed for the time it was gone, and the kit gives its chunk to another machine once.
