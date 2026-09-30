import pino from "pino";

/** Structured JSON logs. Never log tokens, transcripts, client details or message bodies. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.SERVICE_NAME ?? "web" },
  redact: {
    paths: ["*.token", "*.password", "*.authorization", "*.cookie", "*.email", "*.transcript", "*.body", "headers.authorization", "headers.cookie"],
    censor: "[redacted]",
  },
});
