/**
 * Structured JSON logger for the V2 pipeline.
 * Each log line is a parseable JSON object — easy to query in Heroku logs / Papertrail.
 *
 * Usage:
 *   const log = createLogger(requestId);
 *   log.info({ step: "vision_analysis", durationMs: 4200, success: true });
 *   log.warn({ step: "copy_gen", reason: "validation_failed", attempt: 1 });
 *   log.error({ step: "fb_fetch", error: "timeout" });
 */

function createLogger(requestId) {
  function write(level, data) {
    const line = JSON.stringify({
      level,
      requestId,
      ts: new Date().toISOString(),
      ...data,
    });
    if (level === "ERROR") {
      console.error(line);
    } else if (level === "WARN") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    info:  (data) => write("INFO",  data),
    warn:  (data) => write("WARN",  data),
    error: (data) => write("ERROR", data),
  };
}

module.exports = { createLogger };
