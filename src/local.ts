// Local backtests: runs the bundled engine (python/) in a private Python environment instead of
// sending the strategy to the HQG server. By default the strategy itself runs in a Docker
// container with the server's limits (the sandbox); "No sandbox" runs it in the engine's own
// process. Free of VS Code APIs so it can be tested on its own.

import { ChildProcess, execFile, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
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

/** The docker command and the sandbox image a sandboxed run uses. */
export type Sandbox = { docker: string; image: string };

/** The run was cancelled; not an error to show. */
export class LocalCancelled extends Error {}

type Pending = { resolve: (reply: Record<string, unknown>) => void; reject: (error: Error) => void };

const MIN_PYTHON: [number, number] = [3, 11]; // pandas 3 needs 3.11
const SANDBOX_REPO = "hqg-local-sandbox";
// The same wording as DOCKER_NOT_RUNNING in python/hqg_local/worker.py.
const DOCKER_NOT_RUNNING =
  "Docker isn't running. Start Docker Desktop (or run `colima start`), or turn on No sandbox.";
const DOCKER_MISSING =
  "Sandboxed local backtests need Docker. Install Docker Desktop or Colima, or turn on No sandbox.";

export class LocalEngine {
  private readonly envDir: string;
  private readonly python: string;
  private readonly requirements: string;
  private readonly marker: string;
  private settingUp?: Promise<void>;
  private sandbox?: Sandbox;
  private preparingSandbox?: Promise<Sandbox>;
  private worker?: ChildProcess;
  private ready?: Promise<void>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** After this long without a run or prefetch, the worker and its waiting container stop. */
  private idleMs = 60 * 60 * 1000;
  private idleTimer?: NodeJS.Timeout;

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

  /**
   * Check that Docker is running and the sandbox image exists, building it the first time (and
   * after an update changes the engine). Checked once per session.
   */
  prepareSandbox(report: (message: string) => void): Promise<Sandbox> {
    if (this.sandbox) return Promise.resolve(this.sandbox);
    this.preparingSandbox ??= this.doPrepareSandbox(report).finally(() => (this.preparingSandbox = undefined));
    return this.preparingSandbox;
  }

  /** The sandbox, if it has been checked this session. */
  readySandbox(): Sandbox | undefined {
    return this.sandbox;
  }

  /** Run a backtest; with `sandbox`, the strategy runs in a container, otherwise in the engine. */
  async run(request: LocalRunRequest, timeoutMs: number, sandbox?: Sandbox): Promise<LocalRunResult> {
    const timer = setTimeout(() => {
      this.stop(new Error(`Gave up after ${Math.round(timeoutMs / 1000)}s; the local run was stopped.`));
    }, timeoutMs);
    try {
      const reply = await this.send({ cmd: "run", ...request, sandbox });
      return { result: reply.result as BacktestResult, logs: (reply.logs as string[]) ?? [] };
    } catch (error) {
      // Docker stopped since it was checked: check (and report) again on the next run.
      if ((error as Error).message.includes(DOCKER_NOT_RUNNING)) this.sandbox = undefined;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download the strategy's prices ahead of time and, with `sandbox`, start the container the
   * run will use. Only when already set up; failures are ignored.
   */
  async prefetch(code: string, sandbox?: Sandbox): Promise<void> {
    if (!this.isSetUp()) return;
    try {
      const reply = await this.send({ cmd: "prefetch", code, sandbox });
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
    clearTimeout(this.idleTimer);
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

  // ── sandbox ──────────────────────────────────────────────────────────────

  private async doPrepareSandbox(report: (message: string) => void): Promise<Sandbox> {
    const docker = this.findDocker();
    if (!docker) throw new Error(DOCKER_MISSING);
    const env = this.dockerEnv(docker);
    try {
      await this.exec(docker, ["info", "--format", "{{.ServerVersion}}"], true, env);
    } catch {
      throw new Error(DOCKER_NOT_RUNNING);
    }

    // The image is named after what goes into it, so an update that changes the engine rebuilds it.
    const image = `${SANDBOX_REPO}:${this.sandboxHash().slice(0, 12)}`;
    const built = await this.exec(docker, ["image", "inspect", "--format", "{{.Id}}", image], true, env).then(
      () => true,
      () => false
    );
    if (!built) {
      report("building the sandbox (one time, about a minute)");
      this.log(`  local engine: building ${image} with ${docker}`);
      const pythonDir = path.join(this.extensionDir, "python");
      await this.exec(docker, ["build", "--quiet", "-t", image, "-f", path.join(pythonDir, "sandbox", "Dockerfile"), pythonDir], false, env);
      // Remove the images older versions of the extension built.
      const tags = await this.exec(docker, ["image", "ls", SANDBOX_REPO, "--format", "{{.Tag}}"], true, env).catch(() => "");
      const old = tags.split("\n").map((tag) => tag.trim()).filter((tag) => tag && `${SANDBOX_REPO}:${tag}` !== image);
      if (old.length) {
        await this.exec(docker, ["image", "rm", ...old.map((tag) => `${SANDBOX_REPO}:${tag}`)], true, env).catch(() => "");
      }
    }
    this.sandbox = { docker, image };
    return this.sandbox;
  }

  /** The docker command: on the PATH, or where Docker Desktop, Colima, OrbStack or Rancher put it. */
  private findDocker(): string | undefined {
    const exe = process.platform === "win32" ? "docker.exe" : "docker";
    const home = os.homedir();
    const places = [
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      path.join(home, ".docker", "bin"),
      "/Applications/Docker.app/Contents/Resources/bin",
      path.join(home, ".orbstack", "bin"),
      path.join(home, ".rd", "bin"),
      "C:\\Program Files\\Docker\\Docker\\resources\\bin",
    ];
    return places.map((dir) => path.join(dir, exe)).find((file) => fs.existsSync(file));
  }

  /** Docker Desktop's credential helpers sit next to the docker command, which may not be on the PATH. */
  private dockerEnv(docker: string): NodeJS.ProcessEnv {
    return { ...process.env, PATH: path.dirname(docker) + path.delimiter + (process.env.PATH ?? "") };
  }

  /** A hash of everything copied into the sandbox image. */
  private sandboxHash(): string {
    const pythonDir = path.join(this.extensionDir, "python");
    const files = [
      path.join(pythonDir, "sandbox", "Dockerfile"),
      path.join(pythonDir, "sandbox", "requirements.txt"),
      path.join(pythonDir, "hqg_local", "sandbox_runner.py"),
    ];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__pycache__") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(path.join(pythonDir, "vendor"));
    const hash = crypto.createHash("sha256");
    for (const file of files.sort()) hash.update(path.relative(pythonDir, file)).update(fs.readFileSync(file));
    return hash.digest("hex");
  }

  /** Remove the containers a stopped worker left running (the worker labels them with its pid). */
  private removeContainers(pid: number): void {
    const sandbox = this.sandbox;
    if (!sandbox) return;
    const env = this.dockerEnv(sandbox.docker);
    this.exec(sandbox.docker, ["ps", "-q", "--filter", `label=hqg-sandbox-owner=${pid}`], true, env)
      .then((out) => {
        const ids = out.split("\n").map((id) => id.trim()).filter(Boolean);
        if (ids.length) return this.exec(sandbox.docker, ["rm", "-f", ...ids], true, env);
      })
      .catch(() => {});
  }

  private exec(command: string, args: string[], quiet = false, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 16 * 1024 * 1024, env }, (error, stdout, stderr) => {
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

  /** Restart the idle countdown; called on every request. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.rest(), this.idleMs);
  }

  /** Idle long enough: stop the worker, which ends its waiting sandbox container. The next request starts it again. */
  private rest(): void {
    if (this.pending.size) return this.touch(); // a long run is still going
    if (!this.worker) return;
    this.log(`  local engine: unused for ${Math.round(this.idleMs / 60000)} min; stopped it and its sandbox container`);
    this.stop(new LocalCancelled("Idle"));
  }

  private async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.touch();
    await this.startWorker();
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.stdin!.write(JSON.stringify({ id, ...message }) + "\n");
    });
    // The countdown runs from when the last request finished.
    reply.then(() => this.touch(), () => this.touch());
    return reply;
  }

  /** Kill the worker and fail whatever was waiting on it with `reason`. */
  private stop(reason: Error): void {
    const worker = this.worker;
    this.reset(reason);
    worker?.kill();
    // A running container doesn't stop with the worker; its waiting ones exit by themselves.
    if (worker?.pid) this.removeContainers(worker.pid);
  }

  private reset(reason: Error): void {
    this.worker = undefined;
    this.ready = undefined;
    for (const waiting of this.pending.values()) waiting.reject(reason);
    this.pending.clear();
  }
}
