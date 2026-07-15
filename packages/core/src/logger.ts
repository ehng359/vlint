export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

let current: Logger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// Hosts (extension, CLI, MCP) route core output to their own channel.
export function setLogger(logger: Logger): void {
  current = logger;
}

export function getLogger(): Logger {
  return current;
}
