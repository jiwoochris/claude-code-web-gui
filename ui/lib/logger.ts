type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, extra?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...extra,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, extra?: Record<string, unknown>) => emit("info", event, extra),
  warn: (event: string, extra?: Record<string, unknown>) => emit("warn", event, extra),
  error: (event: string, extra?: Record<string, unknown>) => emit("error", event, extra),
};
