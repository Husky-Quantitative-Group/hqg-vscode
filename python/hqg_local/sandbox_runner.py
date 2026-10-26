"""Runs one strategy inside the local sandbox container (see SandboxExecutor in worker.py).

The worker starts the container ahead of time; it waits here until the run arrives on stdin:

  line 1:  JSON header: strategy_code, name, initial_capital, alt_data, config_params, profile,
           columns ([symbol, field] per price column) and index (ISO dates, as the server sends)
  then:    one .npy array per price column, in the header's order (no pickles)

It replies with hqg-backtester's RawExecutionResult as JSON on stdout, the same reply the server's
container gives, and exits. A closed stdin with no run means the worker no longer needs it.
"""

import cProfile
import io
import json
import pstats
import sys
import time
import warnings

warnings.filterwarnings("ignore")

# The reply goes on the real stdout; anything the strategy prints goes to stderr.
_reply = sys.stdout
sys.stdout = sys.stderr
sys.path.insert(0, "/hqg/vendor")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.execution.container import entrypoint  # noqa: E402
from src.models.execution import ExecutionPayload, RawExecutionResult  # noqa: E402
from src.models.request import BacktestRequestError  # noqa: E402

# Prices arrive as a ready table instead of the server's JSON.
entrypoint.json_to_dataframe = lambda table: table


def read_run(stream):
    line = stream.readline()
    if not line.strip():
        return None
    header = json.loads(line)
    columns = [tuple(column) for column in header.pop("columns")]
    # The server's container parses the same ISO strings the same way (entrypoint.json_to_dataframe).
    index = pd.to_datetime(header.pop("index"))
    # NumPy's reader needs a seekable file, which stdin isn't.
    body = io.BytesIO(stream.read())
    arrays = {i: np.lib.format.read_array(body, allow_pickle=False) for i in range(len(columns))}
    table = pd.DataFrame(arrays, index=index)
    table.columns = pd.MultiIndex.from_tuples(columns) if columns else table.columns
    return header, table


def main() -> None:
    run = read_run(sys.stdin.buffer)
    if run is None:
        return
    header, table = run
    profile = bool(header.pop("profile", False))
    payload = ExecutionPayload.model_construct(**header, market_data=table)

    profiler = cProfile.Profile() if profile else None
    start = time.perf_counter()
    try:
        if profiler:
            profiler.enable()
        try:
            result = entrypoint.execute_backtest(payload)
        finally:
            if profiler:
                profiler.disable()
        result["execution_time"] = time.perf_counter() - start
        if profiler:
            report = io.StringIO()
            pstats.Stats(profiler, stream=report).sort_stats("cumulative").print_stats(40)
            result["profile"] = report.getvalue()
        reply = RawExecutionResult(**result)
    except Exception as error:  # noqa: BLE001 - every failure goes back as an error result
        errors = BacktestRequestError()
        errors.add(f"Strategy execution error: {error}")
        reply = RawExecutionResult(final_value=0.0, final_cash=0.0, errors=errors)
    _reply.write(reply.model_dump_json())
    _reply.flush()


if __name__ == "__main__":
    main()
