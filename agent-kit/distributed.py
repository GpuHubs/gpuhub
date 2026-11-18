"""Spreads independent chunks of work over rented GPUhub machines, collects the results, and stops every session.

    outcome = run_chunks(gh, chunks, files, command, machines=4, max_hourly_usd=0.5, image="python:3.12-slim")

`chunks` is a list of JSON-able pieces of work. Every machine gets `files` (name -> bytes) once, then takes chunks one after another:
chunk i is written to chunk_<i>.json, `command(i)` runs in the workspace, and the command must leave result_<i>.json (any JSON).
A chunk that fails gets one more try, maybe on another machine. Every session is stopped when the work is done, at the deadline,
on an error and on Ctrl+C.
"""
import json
import queue
import threading
import time

from gpuhub import GpuhubError


class Outcome:
    def __init__(self):
        self.results = {}   # chunk index -> parsed result.json
        self.missing = []   # chunk indexes that did not come back
        self.machines = 0   # machines rented
        self.billed = 0.0   # dollars
        self.seconds = 0.0
        self.interrupted = False


def run_chunks(gh, chunks, files, command, machines=4, max_hourly_usd=0.5, image="python:3.12-slim", deadline_sec=900,
               validate=None, log=print, rent_filters=None):
    out = Outcome()
    todo = queue.Queue()
    for i, c in enumerate(chunks):
        todo.put((i, c, 0))
    lock = threading.Lock()
    stop_all = threading.Event()
    active = []  # every rented workspace, so Ctrl+C or an error can stop them straight away
    deadline = time.time() + deadline_sec
    filters = dict(rent_filters or {})
    filters.update({"max_hourly_usd": max_hourly_usd, "image": image})

    def say(msg):
        with lock:
            log(msg)

    def worker(n):
        try:
            work(n)
        except GpuhubError as e:
            say("machine %d: stopped by an error (%s)" % (n, e))

    def work(n):
        try:
            ws = gh.rent(**filters)
        except GpuhubError as e:
            say("machine %d: could not rent (%s)" % (n, e))
            return
        with lock:
            out.machines += 1
            active.append(ws)
        say("machine %d: rented %s" % (n, ws.machine[:10] if ws.machine else "?"))
        bad = 0
        try:
            with ws:
                for name, data in files.items():
                    ws.upload(name, data)
                while not stop_all.is_set() and time.time() < deadline and bad < 2:
                    try:
                        i, chunk, attempt = todo.get_nowait()
                    except queue.Empty:
                        break
                    ok = False
                    try:
                        ws.upload("chunk_%d.json" % i, json.dumps(chunk))
                        left = max(5, min(300, int(deadline - time.time())))
                        r = ws.run(command(i), timeout_sec=left)
                        if r.get("exitCode") == 0:
                            got = json.loads(ws.download("result_%d.json" % i).decode("utf-8"))
                            if validate is None or validate(chunk, got):
                                with lock:
                                    out.results[i] = got
                                ok = True
                        else:
                            say("machine %d: chunk %d failed: %s" % (n, i, (r.get("stderr") or r.get("stdout") or "")[-200:].strip()))
                    except GpuhubError as e:
                        say("machine %d: chunk %d error: %s" % (n, i, e))
                        if e.status in (401, 402, 404, 409):
                            bad = 99  # the session or the money is gone: this machine is done
                    if ok:
                        bad = 0
                    else:
                        bad += 1
                        if attempt < 1:
                            todo.put((i, chunk, attempt + 1))  # one more try, maybe on another machine
                ws.stop()
        finally:
            with lock:
                out.billed += ws.billed_usd()
        say("machine %d: stopped, billed $%.4f" % (n, ws.billed_usd()))

    threads = [threading.Thread(target=worker, args=(n,), daemon=True) for n in range(max(1, machines))]
    started = time.time()
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(0.2)
    except KeyboardInterrupt:
        out.interrupted = True
        log("\ninterrupted: stopping every session...")
        stop_all.set()
    finally:
        # whatever happened, no session is left running
        for ws in list(active):
            if not ws.stopped:
                try:
                    ws.stop()
                except GpuhubError:
                    pass
        for t in threads:
            t.join(timeout=30)
    out.seconds = time.time() - started
    out.missing = [i for i in range(len(chunks)) if i not in out.results]
    return out
