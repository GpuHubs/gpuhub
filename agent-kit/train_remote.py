#!/usr/bin/env python3
"""Trains a model on ONE rented machine, in the background, and brings the result home.

It starts train_model.py as a background job (a command lives at most 5 minutes, a training run can take longer), shows its log as it goes,
downloads model.pt and metrics.json, and stops the machine. Use it as the pattern for any long job.

    export GPUHUB_KEY=...
    python3 train_remote.py --dry-run
    python3 train_remote.py --prices my_prices.csv --epochs 30

By default it rents a machine with a GPU and the pytorch image. Your data and code go to the machine, never your keys.
"""
import argparse
import os
import sys

import make_prices
from gpuhub import Client, GpuhubError

HERE = os.path.dirname(os.path.abspath(__file__))
PYTORCH = "pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Train a small model on a rented machine.")
    ap.add_argument("--api", default=os.environ.get("GPUHUB_API", "https://gpuhub.app"))
    ap.add_argument("--key", default=os.environ.get("GPUHUB_KEY", ""))
    ap.add_argument("--max-hourly-usd", type=float, default=0.5)
    ap.add_argument("--max-spend-usd", type=float, default=1.0)
    ap.add_argument("--deadline-sec", type=int, default=1800, help="stop the job and the machine after this long")
    ap.add_argument("--image", default=PYTORCH)
    ap.add_argument("--python", default="python3")
    ap.add_argument("--no-gpu", action="store_true", help="rent a machine without requiring a GPU")
    ap.add_argument("--min-vram-gb", type=float, default=4)
    ap.add_argument("--prices", help="a prices.csv, one price per line (default: a synthetic series)")
    ap.add_argument("--bars", type=int, default=50000)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--window", type=int, default=32)
    ap.add_argument("--script", default="train_model.py", help="the training script to run (default: the template)")
    ap.add_argument("--out-dir", default=".", help="where to put model.pt and metrics.json")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    gh = Client(a.key or "dry", a.api) if a.dry_run else Client(a.key, a.api)
    worst = a.max_hourly_usd * a.deadline_sec / 3600.0
    free = [m for m in gh.machines() if m.get("available") and m.get("kind") == "container" and (a.no_gpu or m["specs"].get("gpu"))]
    free = [m for m in free if int(m["effectiveHourlyUnits"]) / 1e6 <= a.max_hourly_usd]
    print("%d suitable machines are free within $%.3f an hour; worst case for this run: $%.4f" % (len(free), a.max_hourly_usd, worst))
    if a.dry_run:
        return 0
    if worst > a.max_spend_usd:
        print("refusing: the worst case $%.4f is above --max-spend-usd %.2f" % (worst, a.max_spend_usd))
        return 1

    prices = open(a.prices, "rb").read() if a.prices else ("\n".join(str(p) for p in make_prices.make(a.bars)) + "\n").encode()
    script_path = a.script if os.path.exists(a.script) else os.path.join(HERE, a.script)
    with open(script_path, "rb") as f:
        script = f.read()
    filters = {"max_hourly_usd": a.max_hourly_usd, "image": a.image}
    if not a.no_gpu:
        filters.update({"gpu": True, "min_vram_gb": a.min_vram_gb})
    try:
        ws = gh.rent(**filters)
    except GpuhubError as e:
        print("could not rent a machine: %s" % e)
        return 1
    print("rented %s" % (ws.machine or "")[:10])
    code = 1
    try:
        with ws:
            ws.upload("prices.csv", prices)
            ws.upload("train_model.py", script)
            ws.start("%s train_model.py --prices prices.csv --epochs %d --window %d" % (a.python, a.epochs, a.window), name="train")
            print("training started, log follows")
            status = ws.wait("train", timeout=a.deadline_sec, poll=5, on_log=lambda s: print(s, end="", flush=True))
            if status["exit_code"] == 0:
                os.makedirs(a.out_dir, exist_ok=True)
                for name in ("model.pt", "metrics.json"):
                    with open(os.path.join(a.out_dir, name), "wb") as f:
                        f.write(ws.download(name))
                print("saved model.pt and metrics.json in %s" % a.out_dir)
                code = 0
            else:
                print("the job ended with exit code %s" % status["exit_code"])
            ws.stop()
    except GpuhubError as e:
        print("stopped: %s" % e)
    except KeyboardInterrupt:
        print("\ninterrupted: stopping the machine...")
    finally:
        if not ws.stopped:
            try:
                ws.stop()
            except GpuhubError:
                pass
        print("billed $%.4f" % ws.billed_usd())
    return code


if __name__ == "__main__":
    sys.exit(main())
