// ─── Tagged Logger ────────────────────────────────────────────────────────────
//
// Usage:
//   const log = require("./utils/logger")("DriverQueue");
//   log.info("Trip added", { tripId: 123 });
//   // → [2026-03-06T10:30:00.000Z] [DriverQueue] Trip added { tripId: 123 }

/**
 * Creates a tagged logger instance.
 * @param {string} tag — Module/service name shown in log prefix.
 */
function createLogger(tag) {
  const prefix = () => `[${new Date().toISOString()}] [${tag}]`;

  return {
    info: (...args) => console.log(prefix(), ...args),
    warn: (...args) => console.warn(prefix(), "⚠", ...args),
    error: (...args) => console.error(prefix(), "✖", ...args),
    debug: (...args) => {
      if (process.env.DEBUG) console.log(prefix(), "⊙", ...args);
    },
  };
}

module.exports = createLogger;
