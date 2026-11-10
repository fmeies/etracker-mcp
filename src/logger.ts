const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function isLevel(value: string): value is Level {
  return Object.hasOwn(LEVELS, value);
}

const configuredLevel = process.env.LOG_LEVEL ?? "info";
if (!isLevel(configuredLevel)) {
  throw new Error(`Invalid LOG_LEVEL "${configuredLevel}". Use one of: ${Object.keys(LEVELS).join(", ")}.`);
}
const threshold = LEVELS[configuredLevel];

function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }) + "\n";
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => log("info",  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log("warn",  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};
