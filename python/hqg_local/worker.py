"""Local backtest worker for the HQG Backtester extension.

The extension starts this once and keeps it running, so pandas and the engine load only once.
It reads one JSON request per line on stdin and writes one JSON reply per line on stdout:

  {"id": 1, "cmd": "run", "code": "...", "name": "...", "start": "2020-01-01",
   "end": "2024-01-01", "capital": 10000, "profile": false,
   "sandbox": {"docker": "/usr/local/bin/docker", "image": "hqg-local-sandbox:..."}}
      -> {"id": 1, "ok": true, "result": {<BacktestResponse>}, "logs": [...]}
  {"id": 2, "cmd": "prefetch", "code": "...", "sandbox": {...}}
      -> {"id": 2, "ok": true, "symbols": [...]}
  Any failure -> {"id": n, "ok": false, "error": "..."}

It runs hqg-backtester's own pipeline (python/vendor/src): code checks, price download, the
strategy run and the metrics. With "sandbox", the strategy runs in a Docker container with the
server's limits (SandboxExecutor); without it ("No sandbox"), in this process. Either way,
price tables skip the server's JSON round trip, and the results match the server's.
"""

import asyncio
import contextlib
import cProfile
import io
import json
import logging
import os
import pstats
import subprocess
import sys
import threading
import time
import warnings
from datetime import datetime

# Replies go on the real stdout; anything else that prints (strategies, libraries) goes to stderr,
# which the extension writes to its Output panel.
_replies = sys.stdout
sys.stdout = sys.stderr

# yfinance re-enables its own warnings (hundreds of pandas deprecation notices per download), so
# filtering isn't enough: drop them at the point they'd be shown.
warnings.filterwarnings("ignore")
warnings.showwarning = lambda *args, **kwargs: None
logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from hqg_algorithms import BarSize, extract_metadata  # noqa: E402

from src.execution import orchestrator as orchestrator_module  # noqa: E402
from src.execution.container import entrypoint  # noqa: E402
from src.models.execution import ExecutionPayload, RawExecutionResult  # noqa: E402
from src.models.request import BacktestRequest, BacktestRequestError  # noqa: E402
from src.utils.build_response import build_backtest_response  # noqa: E402

# ── Hand price tables over directly ─────────────────────────────────────────
# On the server, prices cross into a Docker container as JSON. In-process, the orchestrator's
# table→JSON step becomes a pass-through and the entrypoint's JSON→table step accepts the table.
# The payload model only accepts dicts, so it's built without re-validating the table.
_json_to_dataframe = entrypoint.json_to_dataframe


def _select_universe(data: pd.DataFrame, symbols: list[str]) -> pd.DataFrame:
    return data.loc[:, data.columns.get_level_values(0).isin(symbols)]


def _accept_table(market_data):
    return market_data if isinstance(market_data, pd.DataFrame) else _json_to_dataframe(market_data)


orchestrator_module.dataframe_to_json = _select_universe
entrypoint.json_to_dataframe = _accept_table
orchestrator_module.ExecutionPayload = lambda **fields: ExecutionPayload.model_construct(**fields)


class InProcessExecutor:
    """Stands in for the Docker executor: runs the strategy in this process."""

    def execute(self, payload: ExecutionPayload, profile: bool = False) -> RawExecutionResult:
        profiler = cProfile.Profile() if profile else None
        start = time.perf_counter()
        if profiler:
            profiler.enable()
        try:
            result = entrypoint.execute_backtest(payload)
        finally:
            if profiler:
                profiler.disable()
        result["execution_time"] = time.perf_counter() - start
        if profiler:
            # Same report as the server's profiling container.
            report = io.StringIO()
            pstats.Stats(profiler, stream=report).sort_stats("cumulative").print_stats(40)
            result["profile"] = report.getvalue()
        return RawExecutionResult(**result)


# The extension matches this wording to know the sandbox needs checking again (src/local.ts).
DOCKER_NOT_RUNNING = ("Docker isn't running. Start Docker Desktop (or run `colima start`), "
                      "or turn on No sandbox.")

# The server's container settings (hqg-backtester src/execution/executor.py).
SANDBOX_LIMITS = [
    "--network=none",
    "--read-only",
    "--tmpfs", "/tmp:size=64m",
    "--memory=512m",
    "--cpus=1",
    "--pids-limit=64",
    "--security-opt=no-new-privileges",
    "--cap-drop=ALL",
]


class SandboxExecutor:
    """Stands in for the Docker executor: runs the strategy in a fresh, locked-down container.

    The next container is started while the current run is going, so a run doesn't wait for one
    to boot. Prices go in as plain arrays (sandbox_runner.py reads them); the result comes back as
    JSON and is validated like the server's, so nothing from the container is ever executed here.
    """

    def __init__(self, docker: str, image: str):
        self.docker = docker
        self.image = image
        self._next: subprocess.Popen | None = None
        # Docker Desktop's credential helpers sit next to the docker command.
        self._env = {**os.environ, "PATH": os.path.dirname(docker) + os.pathsep + os.environ.get("PATH", "")}

    def warm(self) -> None:
        if self._next is None or self._next.poll() is not None:
            self._next = self._start()

    def close(self) -> None:
        # A container with nothing on stdin exits by itself.
        if self._next is not None and self._next.poll() is None:
            self._next.stdin.close()
        self._next = None

    def _start(self) -> subprocess.Popen:
        return subprocess.Popen(
            # The label lets the extension remove this worker's containers if it stops a run.
            [self.docker, "run", "--rm", "--interactive", *SANDBOX_LIMITS,
             "--label", f"hqg-sandbox-owner={os.getpid()}", self.image],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self._env,
        )

    def execute(self, payload: ExecutionPayload, profile: bool = False) -> RawExecutionResult:
        self.warm()
        container, self._next = self._next, None
        self.warm()  # the next run's container boots while this one runs

        table = payload.market_data
        header = {
            "strategy_code": payload.strategy_code,
            "name": payload.name,
            "initial_capital": payload.initial_capital,
            "alt_data": payload.alt_data,
            "config_params": payload.config_params,
            "profile": profile,
            "columns": [list(column) for column in table.columns],
            "index": [ts.isoformat() for ts in table.index],
        }
        message = io.BytesIO()
        message.write(json.dumps(header).encode() + b"\n")
        for column in table.columns:
            np.lib.format.write_array(message, np.ascontiguousarray(table[column].to_numpy()), allow_pickle=False)

        # Pass the strategy's prints on to the Output panel as they come.
        printed_lines: list[str] = []
        printed = threading.Thread(target=self._forward, args=(container.stderr, printed_lines), daemon=True)
        printed.start()
        try:
            container.stdin.write(message.getvalue())
            container.stdin.close()
        except BrokenPipeError:
            pass  # the container already exited; its exit code says why
        reply = container.stdout.read()
        code = container.wait()
        printed.join(timeout=1)

        if not reply.strip():
            errors = BacktestRequestError()
            if code == 137:
                errors.add("The sandbox stopped the strategy: it used more than its 512 MB of memory.")
            elif any("Cannot connect to the Docker daemon" in line for line in printed_lines):
                errors.add(DOCKER_NOT_RUNNING)
            else:
                errors.add(f"The sandbox container exited without a result (exit code {code}). "
                           "See the HQG Backtest output for details.")
            return RawExecutionResult(final_value=0.0, final_cash=0.0, errors=errors, bar_size=payload.bar_size)
        return RawExecutionResult.model_validate_json(reply)

    @staticmethod
    def _forward(stream, lines: list[str]) -> None:
        for raw in stream:
            line = raw.decode(errors="replace")
            lines.append(line)
            sys.stderr.write(line)


orchestrator = orchestrator_module.Orchestrator()
in_process = InProcessExecutor()
sandboxes: dict[tuple[str, str], SandboxExecutor] = {}
# One event loop for the worker's life: the orchestrator's semaphore belongs to the first loop it's used on.
loop = asyncio.new_event_loop()


def sandbox_for(request: dict) -> SandboxExecutor | None:
    """The sandbox a request asks for, or None for "No sandbox"."""
    settings = request.get("sandbox")
    if not settings:
        return None
    key = (settings["docker"], settings["image"])
    if key not in sandboxes:
        for old in sandboxes.values():
            old.close()  # the image was rebuilt; its waiting container is out of date
        sandboxes.clear()
        sandboxes[key] = SandboxExecutor(*key)
    return sandboxes[key]


def run(request: dict) -> dict:
    backtest = BacktestRequest(
        strategy_code=request["code"],
        name=request.get("name") or "local",
        start_date=datetime.fromisoformat(request["start"]),
        end_date=datetime.fromisoformat(request["end"]),
        initial_capital=float(request["capital"]),
        profile=bool(request.get("profile")),
    )
    orchestrator.executor = sandbox_for(request) or in_process
    # The engine logs and the strategy prints go to stderr; replies stay clean.
    with contextlib.redirect_stdout(sys.stderr):
        raw = loop.run_until_complete(orchestrator.run(backtest))
        response = build_backtest_response("local", backtest, raw, orchestrator.securities_provider)
    return {"result": response.model_dump(mode="json"), "logs": raw.strategy_logs}


def prefetch(request: dict) -> dict:
    """Download (or top up) the prices for a strategy's universe so the next run doesn't wait,
    and in sandbox mode start the container the run will use."""
    sandbox = sandbox_for(request)
    if sandbox:
        sandbox.warm()
    metadata = extract_metadata(request["code"])
    symbols = list(metadata.universe)
    if symbols:
        orchestrator.securities_provider.get_data(
            symbols=symbols,
            start_date=datetime(2000, 1, 1),
            end_date=datetime.now(),
            bar_size=BarSize.DAILY,
        )
    return {"symbols": symbols}


COMMANDS = {"run": run, "prefetch": prefetch}


def reply(message: dict) -> None:
    _replies.write(json.dumps(message) + "\n")
    _replies.flush()


def main() -> None:
    reply({"ready": True})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            outcome = COMMANDS[request["cmd"]](request)
            reply({"id": request.get("id"), "ok": True, **outcome})
        except Exception as error:  # noqa: BLE001 - every failure goes back to the extension
            # Validation errors read "<message> (line N); …", which the extension turns into squiggles.
            reply({"id": request.get("id"), "ok": False, "error": str(error) or type(error).__name__})


if __name__ == "__main__":
    main()
