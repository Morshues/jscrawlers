const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Create a namespaced logger. Level comes from `options.level` or LOG_LEVEL env var.
 *
 * @param {string} name namespace shown on every line, e.g. the crawler name
 * @param {{ level?: keyof typeof LEVELS }} [options]
 */
export function createLogger(name, options = {}) {
  const level = LEVELS[options.level ?? process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

  const emit = (kind, args) => {
    if (LEVELS[kind] < level) return;
    const tag = useColor ? `${COLORS[kind]}${kind.padEnd(5)}${RESET}` : kind.padEnd(5);
    const stream = LEVELS[kind] >= LEVELS.warn ? console.error : console.log;
    stream(`${timestamp()} ${tag} [${name}]`, ...args);
  };

  return {
    name,
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    /** Derive a sub-logger, e.g. log.child('page-3') */
    child: (suffix) => createLogger(`${name}:${suffix}`, options),
  };
}

export { LEVELS };
