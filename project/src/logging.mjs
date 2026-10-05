/**
 * Structured logging: exactly one JSON line per event, on stdout.
 *
 * The request log line is what makes a failure locatable: it carries the same
 * request id the client saw, plus method, path, status and duration.
 */

export function createLogger(stream = process.stdout) {
  const write = (level, fields) => {
    const line = { level, ts: new Date().toISOString(), ...fields }
    stream.write(`${JSON.stringify(line)}\n`)
  }
  return {
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  }
}
