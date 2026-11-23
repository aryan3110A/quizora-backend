/**
 * Process lifecycle flag. Once shutdown starts, /health/ready answers 503 so the load balancer stops sending new requests,
 * while in-flight requests finish (server.close) before the process exits.
 */
let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
