// Local backtests: runs the bundled engine (python/) in a private Python environment instead of
// sending the strategy to the HQG server. Free of VS Code APIs so it can be tested on its own.

import { ChildProcess, execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { BacktestResult } from "./api";

export type LocalRunRequest = {
  code: string;
  name: string;
  start: string;
  end: string;
  capital: number;
  profile: boolean;
};

export type LocalRunResult = { result: BacktestResult; logs: string[] };

/** The run was cancelled; not an error to show. */
export class LocalCancelled extends Error {}

type Pending = { resolve: (reply: Record<string, unknown>) => void; reject: (error: Error) => void };

const MIN_PYTHON: [number, number] = [3, 11]; // pandas 3 needs 3.11

export class LocalEngine {
  private readonly envDir: string;
  private readonly python: string;
  private readonly requirements: string;
  private readonly marker: string;
  private settingUp?: Promise<void>;
  private worker?: ChildProcess;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(
    private readonly extensionDir: string,
    private readonly storageDir: string,
    private readonly log: (line: string) => void,
    /** A specific Python to use (the hqg.localPython setting), read at setup time. */
    private readonly pythonOverride: () => string | undefined = () => undefined
  ) {
    this.envDir = path.join(storageDir, "local-engine");
    this.python =
      process.platform === "win32"
        ? path.join(this.envDir, "Scripts", "python.exe")
        : path.join(this.envDir, "bin", "python");
    this.requirements = path.join(extensionDir, "python", "requirements.txt");
    this.marker = path.join(this.envDir, ".hqg-requirements");
  }

  /** True once the private environment exists with the current requirements installed. */
  isSetUp(): boolean {
    try {
      return fs.readFileSync(this.marker, "utf-8") === this.requirementsHash();
    } catch {
      return false;
    }
  }

  /** One-time setup: find Python 3.11+, make a private environment, install the libraries. */
  setup(report: (message: string) => void): Promise<void> {
    this.settingUp ??= this.doSetup(report).finally(() => (this.settingUp = undefined));
    return this.settingUp;
  }

  async run(request: LocalRunRequest, timeoutMs: number): Promise<LocalRunResult> {
    const timer = setTimeout(() => {
      this.stop(new Error(`Gave up after ${Math.round(timeoutMs / 1000)}s; the local run was stopped.`));
    }, timeoutMs);
    try {
      const reply = await this.send({ cmd: "run", ...request });
      return { result: reply.result as BacktestResult, logs: (reply.logs as string[]) ?? [] };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Download the strategy's prices ahead of time. Only when already set up; failures are ignored. */
  async prefetch(code: string): Promise<void> {
    if (!this.isSetUp()) return;
    try {
      const reply = await this.send({ cmd: "prefetch", code });
      const symbols = (reply.symbols as string[]) ?? [];
      if (symbols.length) this.log(`  local prices ready: ${symbols.join(", ")}`);
    } catch {
      // A half-written strategy can fail to parse; the next edit or the run itself will retry.
    }
  }

  /** Stop the current run. The worker restarts on the next request. */
  cancel(): void {
    this.stop(new LocalCancelled("Cancelled"));
  }

  dispose(): void {
    this.stop(new LocalCancelled("Closed"));
  }

  // ── setup ────────────────────────────────────────────────────────────────

  private requirementsHash(): string {
    return crypto.createHash("sha256").update(fs.readFileSync(this.requirements)).digest("hex");
  }

  private async doSetup(report: (message: string) => void): Promise<void> {
    if (this.isSetUp()) return;
    this.stop(new LocalCancelled("Updating"));
    fs.mkdirSync(this.storageDir, { recursive: true });
    const base = await this.findPython();
    this.log(`  local engine: using ${base.join(" ")}`);
    if (!fs.existsSync(this.python)) {
      report("creating a private Python environment");
      await this.exec(base[0], [...base.slice(1), "-m", "venv", this.envDir]);
    }
    report("installing pandas, yfinance and the rest (one time, about a minute)");
    await this.exec(this.python, [
      "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--upgrade", "-r", this.requirements,
    ]);
    // The first load of freshly installed libraries is slow (the OS checks their compiled files);
    // do it now so the first backtest isn't the one that waits.
    report("preparing the engine");
    await this.exec(this.python, ["-W", "ignore", "-c", "import pandas, pyarrow, yfinance, pydantic"], true);
    fs.writeFileSync(this.marker, this.requirementsHash());
  }

  /** The first Python 3.11+ found: the hqg.localPython setting, then the usual commands. */
  private async findPython(): Promise<string[]> {
    const override = this.pythonOverride();
    const candidates: string[][] = override
      ? [[override]]
      : process.platform === "win32"
        ? [["py", "-3.13"], ["py", "-3.12"], ["py", "-3.11"], ["python"]]
        : [["python3.13"], ["python3.12"], ["python3.11"], ["python3"], ["python"]];
    for (const [command, ...args] of candidates) {
      try {
        const out = await this.exec(command, [...args, "-c", "import sys; print(*sys.version_info[:2])"], true);
        const [major, minor] = out.trim().split(" ").map(Number);
        if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) {
          return [command, ...args];
        }
      } catch {
        // Not installed under that name; try the next.
      }
    }
    throw new Error(
      override
        ? `hqg.localPython (${override}) isn't Python 3.11 or newer.`
        : "Local backtests need Python 3.11 or newer. Install it from python.org, or set hqg.localPython to its path."
    );
  }

  private exec(command: string, args: string[], quiet = false): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!quiet && stderr.trim()) this.log(stderr.trim());
        if (error) reject(new Error(stderr.trim().split("\n").pop() || error.message));
        else resolve(stdout);
      });
    });
  }

  // ── worker ───────────────────────────────────────────────────────────────

  private startWorker(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = spawn(this.python, [path.join(this.extensionDir, "python", "hqg_local", "worker.py")], {
      env: {
        ...process.env,
        // The price cache lives with the environment, so it survives restarts and updates.
        DATA_CACHE_DIR: path.join(this.storageDir, "price-cache"),
        PYTHONUNBUFFERED: "1",
        PYTHONWARNINGS: "ignore",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.worker = worker;
    readline.createInterface({ input: worker.stderr! }).on("line", (line) => this.log(`  ${line}`));

    this.ready = new Promise((resolve, reject) => {
      readline.createInterface({ input: worker.stdout! }).on("line", (line) => {
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line);
        } catch {
          this.log(`  ${line}`);
          return;
        }
        if (reply.ready) return resolve();
        const waiting = this.pending.get(reply.id as number);
        if (!waiting) return;
        this.pending.delete(reply.id as number);
        if (reply.ok) waiting.resolve(reply);
        else waiting.reject(new Error(String(reply.error)));
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (this.worker === worker) this.reset(new Error(`The local engine stopped unexpectedly (exit code ${code}).`));
        reject(new Error(`The local engine didn't start (exit code ${code}). See the HQG Backtest output for details.`));
      });
    });
    return this.ready;
  }

  private async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.startWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.stdin!.write(JSON.stringify({ id, ...message }) + "\n");
    });
  }

  /** Kill the worker and fail whatever was waiting on it with `reason`. */
  private stop(reason: Error): void {
    const worker = this.worker;
    this.reset(reason);
    worker?.kill();
  }

  private reset(reason: Error): void {
    this.worker = undefined;
    this.ready = undefined;
    for (const waiting of this.pending.values()) waiting.reject(reason);
    this.pending.clear();
  }
}
