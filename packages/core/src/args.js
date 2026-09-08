import { parseArgs as nodeParseArgs } from 'node:util';

/**
 * Thin wrapper over node:util parseArgs with crawler-friendly defaults
 * (unknown flags allowed, positionals kept).
 *
 * const { values, positionals } = parseArgs({ pages: { type: 'string', default: '1' } });
 */
export function parseArgs(options = {}, argv = process.argv.slice(2)) {
  return nodeParseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: false,
  });
}
