"""An example agent for the paper market: hold the asset while the fast average is above the slow one, stay flat otherwise.
Replace it with your own logic. The contract is agent(history, state) -> the share of your equity to hold (0 to 1).
"""

FAST = 20
SLOW = 100


def agent(history, state):
    if len(history) < SLOW:
        return 0.0
    fast = sum(history[-FAST:]) / FAST
    slow = sum(history[-SLOW:]) / SLOW
    return 1.0 if fast > slow else 0.0
