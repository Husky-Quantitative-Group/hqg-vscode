"""Local backtest worker for the HQG Backtester extension.

The extension starts this once and keeps it running, so pandas and the engine load only once.
It reads one JSON request per line on stdin and writes one JSON reply per line on stdout:

  {"id": 1, "cmd": "run", "code": "...", "name": "...", "start": "2020-01-01",
   "end": "2024-01-01", "capital": 10000, "profile": false}
      -> {"id": 1, "ok": true, "result": {<BacktestResponse>}, "logs": [...]}
  {"id": 2, "cmd": "prefetch", "code": "..."}
      -> {"id": 2, "ok": true, "symbols": [...]}
  Any failure -> {"id": n, "ok": false, "error": "..."}

It runs hqg-backtester's own pipeline (python/vendor/src) with two swaps: the strategy runs in
this process instead of a Docker container, and price tables are handed over directly instead of
being turned into JSON and back. Everything else, including the results, matches the server.
"""

import asyncio
import contextlib
import cProfile
import io
import json
import logging
import os
import pstats
import sys
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

import pandas as pd  # noqa: E402
from hqg_algorithms import BarSize, extract_metadata  # noqa: E402

from src.execution import orchestrator as orchestrator_module  # noqa: E402
from src.execution.container import entrypoint  # noqa: E402
from src.models.execution import ExecutionPayload, RawExecutionResult  # noqa: E402
from src.models.request import BacktestRequest  # noqa: E402
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


orchestrator = orchestrator_module.Orchestrator()
orchestrator.executor = InProcessExecutor()
# One event loop for the worker's life: the orchestrator's semaphore belongs to the first loop it's used on.
loop = asyncio.new_event_loop()


def run(request: dict) -> dict:
    backtest = BacktestRequest(
        strategy_code=request["code"],
        name=request.get("name") or "local",
        start_date=datetime.fromisoformat(request["start"]),
        end_date=datetime.fromisoformat(request["end"]),
        initial_capital=float(request["capital"]),
        profile=bool(request.get("profile")),
    )
    # The engine logs and the strategy prints go to stderr; replies stay clean.
    with contextlib.redirect_stdout(sys.stderr):
        raw = loop.run_until_complete(orchestrator.run(backtest))
        response = build_backtest_response("local", backtest, raw, orchestrator.securities_provider)
    return {"result": response.model_dump(mode="json"), "logs": raw.strategy_logs}


def prefetch(request: dict) -> dict:
    """Download (or top up) the prices for a strategy's universe so the next run doesn't wait."""
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
