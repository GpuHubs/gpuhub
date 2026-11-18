"""A template for training a small model with PyTorch: windows of recent returns in, the direction of the next bar out.

It shows the parts every such pipeline needs: windowing a series, a split in TIME order (never shuffled, so the model can't see the
future), early stopping, and numbers you can compare to a coin flip. Replace the features, the label and the model with your own.

    python3 train_model.py --prices prices.csv --epochs 20 --out model.pt

Uses the GPU when there is one. Needs torch, which the pytorch image has. A trained model on past prices says little about the future:
this is a template for the pipeline, not advice.
"""
import argparse
import json
import math
import sys
import time


def make_windows(prices, window):
    """Features: the last `window` log-returns. Label: 1 if the next bar's return is positive. Returns (X, y) as plain lists."""
    rets = [math.log(prices[i + 1] / prices[i]) for i in range(len(prices) - 1)]
    X, y = [], []
    for i in range(window, len(rets)):
        X.append(rets[i - window: i])
        y.append(1.0 if rets[i] > 0 else 0.0)
    return X, y


def split_in_time(X, y, val_share=0.2):
    """The last part of the series is the validation set. Never shuffle a time series before splitting."""
    cut = int(len(X) * (1.0 - val_share))
    return (X[:cut], y[:cut]), (X[cut:], y[cut:])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", default="prices.csv")
    ap.add_argument("--window", type=int, default=32)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--patience", type=int, default=4, help="stop after this many epochs without a better validation loss")
    ap.add_argument("--out", default="model.pt")
    ap.add_argument("--metrics", default="metrics.json")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)

    import torch
    from torch import nn

    torch.manual_seed(a.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    with open(a.prices) as f:
        prices = [float(x) for x in f if x.strip()]
    X, y = make_windows(prices, a.window)
    (Xt, yt), (Xv, yv) = split_in_time(X, y)
    print("device %s, %d training and %d validation windows" % (device, len(Xt), len(Xv)), flush=True)

    def tensor(v):
        return torch.tensor(v, dtype=torch.float32, device=device)

    Xt, yt, Xv, yv = tensor(Xt), tensor(yt), tensor(Xv), tensor(yv)
    scale = Xt.std().clamp_min(1e-8)  # fitted on the training part only
    Xt, Xv = Xt / scale, Xv / scale

    model = nn.Sequential(nn.Linear(a.window, a.hidden), nn.ReLU(), nn.Linear(a.hidden, a.hidden), nn.ReLU(), nn.Linear(a.hidden, 1)).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)
    loss_fn = nn.BCEWithLogitsLoss()
    best, best_state, since = float("inf"), None, 0
    started = time.time()
    for epoch in range(1, a.epochs + 1):
        model.train()
        order = torch.randperm(len(Xt), device=device)
        total = 0.0
        for i in range(0, len(Xt), a.batch):
            idx = order[i: i + a.batch]
            opt.zero_grad()
            loss = loss_fn(model(Xt[idx]).squeeze(1), yt[idx])
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        model.eval()
        with torch.no_grad():
            logits = model(Xv).squeeze(1)
            vloss = loss_fn(logits, yv).item()
            acc = ((logits > 0).float() == yv).float().mean().item()
        print("epoch %2d  train loss %.4f  validation loss %.4f  validation accuracy %.3f  (%.1fs)" % (epoch, total / len(Xt), vloss, acc, time.time() - started), flush=True)
        if vloss < best - 1e-5:
            best, since = vloss, 0
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            since += 1
            if since >= a.patience:
                print("stopping early: no better validation loss for %d epochs" % a.patience, flush=True)
                break
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        final_acc = ((model(Xv).squeeze(1) > 0).float() == yv).float().mean().item()
    base = max(yv.mean().item(), 1.0 - yv.mean().item())
    torch.save({"state": best_state, "window": a.window, "hidden": a.hidden, "scale": float(scale)}, a.out)
    metrics = {"device": device, "validation_loss": best, "validation_accuracy": final_acc, "always_guess_majority_accuracy": base, "seconds": time.time() - started}
    with open(a.metrics, "w") as f:
        json.dump(metrics, f)
    print("done: validation accuracy %.3f against %.3f for always guessing the majority direction" % (final_acc, base), flush=True)
    print("a model that does not beat that baseline has learned nothing useful", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
