const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "..", "logs", "automation.log");

function getTimestamp() {
  return new Date().toISOString();
}

function ensureLogDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(level, message, meta) {
  ensureLogDir();
  const ts = getTimestamp();
  const metaStr = meta ? ` | ${JSON.stringify(meta)}` : "";
  const line = `[${ts}] [${level}] ${message}${metaStr}\n`;

  // Console output
  if (level === "ERROR") {
    console.error(line.trim());
  } else if (level === "WARN") {
    console.warn(line.trim());
  } else {
    console.log(line.trim());
  }

  // File output
  fs.appendFileSync(LOG_FILE, line);
}

function info(message, meta) {
  log("INFO", message, meta);
}

function error(err, meta) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log("ERROR", message, { ...meta, stack });
}

function warn(message, meta) {
  log("WARN", message, meta);
}

module.exports = { info, error, warn, log };
