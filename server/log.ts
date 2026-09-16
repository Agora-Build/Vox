// Timestamped console logger shared by the request middleware (server/index.ts)
// and the background workers (server/scheduler.ts). It lives in its own module
// so scheduler.ts can log without importing server/index.ts — importing the
// entry point would boot the HTTP server (and create an import cycle) the
// moment a test ticks a worker directly.
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}
