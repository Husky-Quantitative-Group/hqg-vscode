// Sign-in state. The token lives in VS Code's secret storage; a token saved by `hqg login` in
// ~/.hqg/credentials counts too, so CLI logins carry over. Signing out never touches that file.

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const SECRET_KEY = "hqg.token";
// The CLI token in use when the user signed out here; ignored until `hqg login` writes a new one.
const IGNORED_CLI_TOKEN_KEY = "hqg.ignoredCliToken";
const CREDENTIALS_PATH = path.join(process.env.HQG_HOME ?? path.join(os.homedir(), ".hqg"), "credentials");

export type AuthState =
  | { signedIn: true; token: string; source: "vscode" | "cli"; netid?: string; expiresAt?: number }
  | { signedIn: false; reason?: string };

// Tokens the service turned away this session, e.g. revoked before they expired.
const rejected = new Set<string>();

async function readCliToken(): Promise<string | undefined> {
  try {
    return (await fs.readFile(CREDENTIALS_PATH, "utf-8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The JWT's claims, read without verifying it; the service does the verifying. */
function readClaims(token: string): { sub?: string; exp?: number } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
  } catch {
    return {};
  }
}

/** A reason a pasted token can't be used, found without asking the service. */
export function tokenProblem(token: string): string | undefined {
  const { sub, exp } = readClaims(token);
  if (!sub) return "That doesn't look like an hqg_auth_token value. Copy the whole Value column.";
  if (typeof exp === "number" && exp * 1000 <= Date.now()) {
    return "That token has expired. Sign in to the dashboard again and copy the new one.";
  }
  return undefined;
}

export async function authState(context: vscode.ExtensionContext): Promise<AuthState> {
  let token = await context.secrets.get(SECRET_KEY);
  let source: "vscode" | "cli" = "vscode";
  if (!token) {
    const cliToken = await readCliToken();
    if (cliToken && cliToken !== context.globalState.get(IGNORED_CLI_TOKEN_KEY)) {
      token = cliToken;
      source = "cli";
    }
  }
  if (!token) {
    return { signedIn: false };
  }
  if (rejected.has(token)) {
    return { signedIn: false, reason: "The backtester turned down your sign-in. Sign in again." };
  }

  const { sub, exp } = readClaims(token);
  const expiresAt = typeof exp === "number" ? exp * 1000 : undefined;
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return { signedIn: false, reason: "Your sign-in expired. Sign in again." };
  }
  return { signedIn: true, token, source, netid: sub, expiresAt };
}

/** Call when the service answers 401 for this token. */
export function markRejected(token: string): void {
  rejected.add(token);
}

export async function saveToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  token = token.trim();
  rejected.delete(token);
  await context.secrets.store(SECRET_KEY, token);
  await context.globalState.update(IGNORED_CLI_TOKEN_KEY, undefined);
}

export async function signOut(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  await context.globalState.update(IGNORED_CLI_TOKEN_KEY, await readCliToken());
}
