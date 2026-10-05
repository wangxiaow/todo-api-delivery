# Frozen semantic driver interface (tests/acceptance/spec → driver)

The specs in this directory never touch selectors, URLs, headers or storage fields
directly; they call the semantic interface below and assert on what it observed.
The adapter that implements this interface lives in `tests/acceptance/driver/`,
is owned by the implementation session, and **must not decide pass/fail**: no
`expect`, no `assert`, no turning an exception into success. It returns what
happened, including non-2xx responses.

```js
// Default export of tests/acceptance/driver/index.mjs
const api = {
  // Fresh absolute path for a database that does not exist yet.
  newDbPath(): string,
  // Scratch directory owned by this acceptance run.
  tmpDir(): string,
  // Creates (if needed) and returns the absolute path of a real file inside the
  // scratch directory; used where an existing *file* must get in the way.
  newTmpFile(): string,
  // A loopback port that currently has no listener.
  freePort(): Promise<number>,
  fileExists(path): boolean,
  // Absolute path resolved inside the project root (e.g. 'README.md').
  readText(relativePath): string,

  // Start the service. Defaults: a fresh database, tokens
  // 'alice:alice-secret,bob:bob-secret', an ephemeral loopback port.
  startServer(options?): Promise<Handle>,
  restartServer(handle): Promise<Handle>,
  stopServer(handle): Promise<{ code, signal }>,
  // true when something accepts a TCP connection on that port.
  probePort(port): Promise<boolean>,
  // Run the documented entry point directly (CLI surface, fail-fast startup).
  runCli({ args, env, cwd?, timeoutMs? }): Promise<{ code, stdoutText, stderrText }>,
  // Poll the captured stdout until one parsed JSON log line satisfies the
  // predicate; resolves null when the timeout expires. Never throws for "not found".
  waitForLog(handle, predicate: (line) => boolean, timeoutMs?): Promise<object|null>,

  // One HTTP request. Resolves for any status; rejects only on transport failure.
  request(handle, {
    method, path,
    token,        // string -> Authorization: Bearer <token>; null/undefined -> no header
    headers,      // extra headers, merged over the defaults
    body,         // object -> JSON body
    rawBody,      // string -> sent verbatim as the body
    timeoutMs,
  }): Promise<{ status, headers, bodyText, body, elapsedMs }>,

  // Remove every scratch resource created by this run.
  cleanup(): Promise<void>,
}

// Handle
{
  baseUrl, port, pid, dbPath, env,
  stdoutText(): string,
  stderrText(): string,
  logs(): object[],   // parsed JSON log lines emitted on stdout
}
```

Conventions the specs rely on:

- `headers` is a lower-case-keyed object, so `headers.location` and
  `headers['x-request-id']` are stable.
- `body` is the parsed JSON body, or `null` when the response has no JSON body.
- `startServer` resolves only after `/readyz` answers 200, so a spec never races
  migrations. It rejects if the process exits or readiness does not arrive.
- `runCli` resolves with the exit code and captured output; it never throws for a
  non-zero exit code (a non-zero exit is an observation, e.g. fail-fast startup).
- `token: null` and `token: undefined` both mean "no Authorization header".
