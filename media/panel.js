// Side panel. Signed out it shows the token box and the steps for finding the token;
// signed in, the run form.
// Every form change is saved, so the panel opens with the same values next time.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const runButton = $("run");
  const cancelButton = $("cancel");
  const errorLine = $("error");
  const tokenForm = $("token-form");
  const tokenError = $("token-error");
  const tokenSubmit = $("token-submit");
  let hasStrategy = false;
  let running = false;

  const readOptions = () => ({
    start: form.start.value,
    end: form.end.value,
    capital: Number(form.capital.value),
    name: form.runName.value.trim(),
    timeoutSeconds: Number(form.timeoutSeconds.value),
    profile: form.profile.checked,
  });

  const problem = (o) => {
    if (!o.start || !o.end) return "Pick a start and an end date.";
    if (o.end <= o.start) return "The end date must be after the start date.";
    if (!(o.capital > 0)) return "Starting equity must be greater than 0.";
    if (!(o.timeoutSeconds > 0)) return "Timeout must be greater than 0.";
    return "";
  };

  const refresh = () => {
    const message = problem(readOptions());
    errorLine.textContent = message;
    errorLine.hidden = !message;
    runButton.disabled = running || !hasStrategy || Boolean(message);
    runButton.title = !hasStrategy ? "Open a strategy file first" : message;
    runButton.hidden = running;
    cancelButton.hidden = !running;
  };

  const timeLeft = (expiresAt) => {
    const minutes = Math.round((expiresAt - Date.now()) / 60000);
    if (minutes < 60) return `${Math.max(minutes, 1)}m left`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  };

  // ── run form ───────────────────────────────────────────────
  form.addEventListener("input", () => {
    refresh();
    vscode.postMessage({ type: "update", options: readOptions() });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!runButton.disabled) vscode.postMessage({ type: "run", options: readOptions() });
  });
  cancelButton.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

  // ── sign in / out ──────────────────────────────────────────
  tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = tokenForm.token.value.trim();
    if (!token) {
      tokenError.textContent = "Paste the hqg_auth_token value first.";
      tokenError.hidden = false;
      return;
    }
    tokenError.hidden = true;
    tokenSubmit.disabled = true;
    tokenSubmit.textContent = "Checking…";
    vscode.postMessage({ type: "signIn", token });
  });
  for (const [id, type] of [["open-dashboard", "openDashboard"], ["sign-out", "signOut"], ["health", "health"]]) {
    $(id).addEventListener("click", (event) => {
      event.preventDefault();
      vscode.postMessage({ type });
    });
  }

  window.addEventListener("message", ({ data }) => {
    if (data.type === "init") {
      const o = data.options;
      form.start.value = o.start;
      form.end.value = o.end;
      form.capital.value = o.capital;
      form.runName.value = o.name;
      form.timeoutSeconds.value = o.timeoutSeconds;
      form.profile.checked = o.profile;
    } else if (data.type === "showSignIn") {
      tokenForm.token.focus();
    } else if (data.type === "signInResult") {
      tokenSubmit.disabled = false;
      tokenSubmit.textContent = "Sign In";
      if (data.error) {
        tokenError.textContent = data.error;
        tokenError.hidden = false;
      } else {
        tokenForm.token.value = "";
      }
    } else if (data.type === "state") {
      const auth = data.auth;
      $("signed-out").hidden = auth.signedIn;
      $("signed-in").hidden = !auth.signedIn;
      $("auth-reason").textContent = auth.reason || "";
      $("auth-reason").hidden = !auth.reason;
      $("account").textContent = auth.signedIn
        ? [
            `Signed in as ${auth.netid || "you"}`,
            auth.expiresAt ? timeLeft(auth.expiresAt) : "",
            auth.source === "cli" ? "from hqg login" : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : "";

      hasStrategy = Boolean(data.strategy);
      running = data.running;
      // No strategy: the highlighted prompt instead of the strategy name.
      $("no-strategy").hidden = hasStrategy;
      $("strategy-block").hidden = !hasStrategy;
      $("strategy").textContent = data.strategyName || data.strategy || "";
      // Under a name from # hqg-backtest, show which file it comes from.
      $("strategy-file").textContent = data.strategy || "";
      $("strategy-file").hidden = !data.strategyName;
      const fallback = data.strategyName || (data.strategy || "").replace(/\.py$/, "");
      form.runName.placeholder = fallback ? `defaults to ${fallback}` : "defaults to the strategy name";
      $("status").textContent = data.status;
    }
    refresh();
  });

  // The width lets the extension widen a too-narrow sidebar once (see widenIfNarrow).
  vscode.postMessage({ type: "ready", width: document.documentElement.clientWidth });
})();
