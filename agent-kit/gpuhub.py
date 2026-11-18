"""A small GPUhub client. Standard library only, so it runs anywhere Python 3.8+ does.

    from gpuhub import Client
    gh = Client(api_key="...", base_url="https://gpuhub.app")
    with gh.rent(gpu=True, min_vram_gb=8) as ws:      # billing starts here
        ws.upload("job.py", open("job.py", "rb").read())
        print(ws.run("python3 job.py")["stdout"])
        data = ws.download("result.json")
    # the session is stopped when the block ends, even if something failed: billing stops that second

The API key is a spending limit signed by your wallet (see https://gpuhub.app/rent). It stays on your machine:
only code and data go to a rented machine, never keys.
"""
import base64
import collections
import json
import re
import shlex
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PIECE = 4 * 1024 * 1024  # bytes per upload call


def _check_name(name):
    if not re.match(r"^[A-Za-z0-9_-]{1,40}$", name):
        raise ValueError("a job name is letters, digits, - and _")


class GpuhubError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__("%s: %s" % (status, message))
        self.status = status
        self.message = message
        self.extra = extra or {}


class Workspace:
    """A rented machine's workspace. Use it in a `with` block so the session is always stopped."""

    def __init__(self, client, session):
        self._c = client
        self.session = session
        self.id = session["id"]
        self.machine = session.get("machine")
        self.stopped = False

    def run(self, command, timeout_sec=60):
        """Runs a shell command. Returns {stdout, stderr, exitCode, timedOut, truncated}."""
        return self._c._call("POST", "/v1/sessions/%s/exec" % self.id, {"command": command, "timeout_sec": timeout_sec})

    def upload(self, path, data):
        """Writes bytes to a path inside the workspace (relative path, no leading slash)."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        sent = 0
        while True:
            piece = data[sent:sent + PIECE]
            self._c._call("POST", "/v1/sessions/%s/files" % self.id, {"path": path, "data": base64.b64encode(piece).decode("ascii"), "append": sent > 0})
            sent += len(piece)
            if sent >= len(data):
                return

    def download(self, path):
        """Reads a whole file from the workspace as bytes."""
        out = b""
        while True:
            q = urllib.parse.urlencode({"path": path, "offset": len(out), "length": PIECE})
            r = self._c._call("GET", "/v1/sessions/%s/files?%s" % (self.id, q))
            piece = base64.b64decode(r.get("data", ""))
            out += piece
            if not piece or len(out) >= int(r.get("size", 0)):
                return out

    # ---- long jobs: a command runs for up to 5 minutes, so run anything longer in the background and watch its log

    def start(self, command, name="job"):
        """Starts a command in the background and returns at once. Watch it with logs(), status() or wait()."""
        _check_name(name)
        wrapped = "mkdir -p .jobs && rm -f .jobs/{n}.exit && (nohup sh -c {c} > .jobs/{n}.log 2>&1 < /dev/null; echo $? > .jobs/{n}.exit) > /dev/null 2>&1 < /dev/null &".format(n=name, c=shlex.quote(command))
        r = self.run(wrapped, timeout_sec=30)
        if r.get("exitCode") != 0:
            raise GpuhubError(0, "could not start the job: %s" % (r.get("stderr") or r.get("stdout") or "").strip()[-200:])
        return name

    def status(self, name="job", tail=2000):
        """Returns {"running": bool, "exit_code": int or None, "log": last bytes of the log}."""
        _check_name(name)
        r = self.run("cat .jobs/{n}.exit 2>/dev/null; echo ---; tail -c {t} .jobs/{n}.log 2>/dev/null".format(n=name, t=int(tail)), timeout_sec=30)
        out = r.get("stdout") or ""
        head, _, log = out.partition("---\n")
        head = head.strip()
        return {"running": head == "", "exit_code": int(head) if head.lstrip("-").isdigit() else None, "log": log}

    def logs(self, name="job", tail=4000):
        return self.status(name, tail)["log"]

    def wait(self, name="job", timeout=3600, poll=5.0, on_log=None):
        """Waits for a background job to finish. Returns its status. `on_log` gets each new piece of the log."""
        seen = 0
        end = time.time() + timeout
        while True:
            s = self.status(name, tail=1_000_000)
            if on_log and len(s["log"]) > seen:
                on_log(s["log"][seen:])
                seen = len(s["log"])
            if not s["running"]:
                return s
            if time.time() > end:
                raise GpuhubError(0, "the job %r did not finish within %d seconds (it is still running; the session is, too)" % (name, timeout))
            time.sleep(poll)

    # ---- keeping your work: a workspace is deleted with its session, so save what you want to keep

    def save(self, local_path, paths=".", exclude=(".jobs", ".save.tgz")):
        """Packs files of the workspace into one archive and downloads it. Restore it into a later session with restore()."""
        ex = " ".join("--exclude=%s" % shlex.quote(e) for e in exclude)
        r = self.run("tar %s -czf .save.tgz %s" % (ex, " ".join(shlex.quote(p) for p in paths.split()) if isinstance(paths, str) else " ".join(shlex.quote(p) for p in paths)), timeout_sec=120)
        if r.get("exitCode") != 0:
            raise GpuhubError(0, "could not pack the workspace: %s" % (r.get("stderr") or "").strip()[-200:])
        data = self.download(".save.tgz")
        with open(local_path, "wb") as f:
            f.write(data)
        return len(data)

    def restore(self, local_path):
        """Unpacks an archive made by save() into this workspace."""
        with open(local_path, "rb") as f:
            self.upload(".restore.tgz", f.read())
        r = self.run("tar -xzf .restore.tgz && rm -f .restore.tgz", timeout_sec=120)
        if r.get("exitCode") != 0:
            raise GpuhubError(0, "could not unpack: %s" % (r.get("stderr") or "").strip()[-200:])

    def info(self):
        return self._c._call("GET", "/v1/sessions/%s" % self.id)

    def stop(self):
        """Stops the session and the billing. Safe to call twice. Returns the final session record."""
        if self.stopped:
            return self.session
        self.stopped = True
        self.session = self._c._call("DELETE", "/v1/sessions/%s" % self.id)
        return self.session

    def billed_usd(self):
        return float(self.session.get("billedUsdUnits", 0)) / 1e6

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        try:
            self.stop()
        except GpuhubError:
            pass  # already ended, for example when the balance ran out
        return False


class Client:
    def __init__(self, api_key, base_url="https://gpuhub.app", timeout=330, max_per_minute=100):
        if not api_key:
            raise ValueError("api_key is empty: create one on https://gpuhub.app/rent")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        # The API allows about 120 requests a minute per key. Keep under it, across all threads, instead of being refused.
        self.max_per_minute = max_per_minute
        self._times = collections.deque()
        self._lock = threading.Lock()

    def _slot(self):
        while True:
            with self._lock:
                now = time.time()
                while self._times and now - self._times[0] > 60:
                    self._times.popleft()
                if len(self._times) < self.max_per_minute:
                    self._times.append(now)
                    return
                wait = 60 - (now - self._times[0]) + 0.05
            time.sleep(wait)

    def _call(self, method, path, body=None, auth=True, retries=4):
        data = None if body is None else json.dumps(body).encode("utf-8")
        for attempt in range(retries + 1):
            self._slot()
            req = urllib.request.Request(self.base_url + path, data=data, method=method)
            req.add_header("content-type", "application/json")
            req.add_header("user-agent", "gpuhub-agent-kit/1")
            if auth:
                req.add_header("authorization", "Bearer " + self.api_key)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read().decode("utf-8") or "null")
            except urllib.error.HTTPError as e:
                try:
                    payload = json.loads(e.read().decode("utf-8"))
                except Exception:
                    payload = {}
                err = payload.get("error", {}) if isinstance(payload, dict) else {}
                if e.code == 429 and attempt < retries:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise GpuhubError(e.code, err.get("message", e.reason), err)
            except urllib.error.URLError as e:
                if attempt < retries:
                    time.sleep(1 + attempt)
                    continue
                raise GpuhubError(0, "cannot reach %s: %s" % (self.base_url, e.reason))

    def machines(self):
        """Machines online, with prices. No key needed."""
        return self._call("GET", "/v1/machines", auth=False)["data"]

    def rent(self, **filters):
        """Rents the cheapest machine that fits. Filters: gpu, min_vram_gb, min_cpu_cores, min_ram_gb, max_hourly_usd, image, machine.
        Billing starts now. Use the result in a `with` block.
        A machine can drop off just as you rent it (it is somebody's PC): that is retried on the next machine."""
        for attempt in range(3):
            try:
                return Workspace(self, self._call("POST", "/v1/sessions", filters))
            except GpuhubError as e:
                if e.status == 502 and attempt < 2:
                    time.sleep(1 + attempt)
                    continue
                raise
