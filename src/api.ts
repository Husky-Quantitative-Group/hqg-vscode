// HTTP client for the hosted backtesting service. Mirrors hqg-backtester/cli/api.py.

// A health check should fail fast; the other calls get a longer budget.
const HEALTH_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_RETRY_AFTER_MS = 60_000;

export type JobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type JobRecord = {
  job_id: string;
  status: JobStatus;
  result?: BacktestResult;
  error?: string;
  logs?: string[];
};

export type BacktestResult = {
  parameters: { name: string; starting_equity: number; start_date: string; end_date: string };
  metrics: Record<string, number | null | undefined>;
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  orders: { id: string; timestamp: string; ticker: string; type: "Buy" | "Sell"; shares: number; price: number }[];
  profile?: string;
};

export type BacktestPayload = {
  strategy_code: string;
  name: string;
  start_date: string;
  end_date: string;
  initial_capital: number;
  profile: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After") ?? 60);
  return Number.isFinite(seconds) ? seconds * 1000 : 60_000;
}

/** The service answered 401: the token is missing, expired or revoked. */
export class AuthError extends Error {}

/** The service could not be reached at all. */
export class NetworkError extends Error {}

export class BacktestClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly token: string | undefined) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Make one request, mapping transport failures and 401s to clear errors. */
  private async send(method: string, path: string, timeoutMs: number, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers["Cookie"] = `hqg_auth_token=${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NetworkError(`Could not reach the backtesting service at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (response.status === 401) {
      throw new AuthError("The backtester turned down your sign-in. Sign in again.");
    }
    return response;
  }

  /** Confirm the service is reachable. */
  async health(): Promise<void> {
    const response = await this.send("GET", "/health", HEALTH_TIMEOUT_MS);
    if (response.status !== 200) {
      throw new Error(`Health check returned HTTP ${response.status}`);
    }
  }

  /**
   * Check the token with the service by asking for a job that cannot exist: a valid token
   * gets 404, a bad one 401. (The backtester itself doesn't guard /health, so that alone
   * would pass a bad token wherever no proxy sits in front.)
   */
  async verifyToken(): Promise<void> {
    const response = await this.send("GET", "/api/v1/backtest/sign-in-check", HEALTH_TIMEOUT_MS);
    if (response.status === 403) {
      throw new Error("Your account doesn't have access to the backtester.");
    }
    if (response.status !== 404 && response.status >= 400) {
      throw new Error(`Sign-in check returned HTTP ${response.status}`);
    }
  }

  /** Enqueue a backtest and return its job id. */
  async submit(payload: BacktestPayload): Promise<string> {
    const response = await this.send("POST", "/api/v1/backtest", REQUEST_TIMEOUT_MS, payload);

    if (response.status === 429) {
      throw new Error(
        `The service is rate limiting this machine. Try again in ${Math.round(retryAfterMs(response) / 1000)}s.`
      );
    }
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).trim()}`);
    }

    const jobId = ((await response.json()) as { job_id?: string }).job_id;
    if (!jobId) {
      throw new Error("The service accepted the job but returned no job id.");
    }
    return jobId;
  }

  /** Return the job record, or undefined if the service has no such job. */
  async getJob(jobId: string): Promise<JobRecord | undefined> {
    while (true) {
      const response = await this.send("GET", `/api/v1/backtest/${jobId}`, REQUEST_TIMEOUT_MS);

      if (response.status === 429) {
        // Wait it out and try again
        await sleep(Math.min(retryAfterMs(response), MAX_RETRY_AFTER_MS));
        continue;
      }
      if (response.status === 404) {
        return undefined;
      }
      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).trim()}`);
      }
      return (await response.json()) as JobRecord;
    }
  }

  /** Ask the service to cancel a job. Returns a description of what happened. */
  async cancel(jobId: string): Promise<string> {
    const response = await this.send("DELETE", `/api/v1/backtest/${jobId}`, REQUEST_TIMEOUT_MS);

    if (response.status === 200) return "cancelled";
    if (response.status === 404) return "no longer exists";
    // only pending jobs can be cancelled.
    if (response.status === 409) return "already started, so it will run to completion";
    return `could not be cancelled (HTTP ${response.status})`;
  }

  /** Poll until the job reaches a terminal state, reporting status changes. */
  async waitForResult(
    jobId: string,
    timeoutMs: number,
    onStatus: (status: JobStatus) => void,
    isCancelled: () => boolean
  ): Promise<JobRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    let lastStatus: JobStatus | undefined;

    while (!isCancelled()) {
      const record = await this.getJob(jobId);
      if (!record) {
        throw new Error(
          `Job ${jobId} no longer exists. The service keeps job state in memory; it may have restarted.`
        );
      }

      if (record.status !== lastStatus) {
        lastStatus = record.status;
        onStatus(record.status);
      }

      if (record.status === "COMPLETED" || record.status === "FAILED" || record.status === "CANCELLED") {
        return record;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Gave up waiting after ${Math.round(timeoutMs / 1000)}s; the job is still ${record.status}.`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)));
    }
    return undefined;
  }
}
