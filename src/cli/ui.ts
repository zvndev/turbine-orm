/**
 * turbine-orm CLI — UI utilities
 *
 * ANSI colors, spinners, box-drawing, and formatting helpers.
 * Zero dependencies — raw escape codes only.
 */

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

const isColorSupported =
  process.env['NO_COLOR'] == null &&
  process.env['TERM'] !== 'dumb' &&
  (process.stdout.isTTY ?? false);

function code(open: string, close: string): (s: string) => string {
  if (!isColorSupported) return (s) => s;
  return (s) => `\x1b[${open}m${s}\x1b[${close}m`;
}

export const bold = code('1', '22');
export const dim = code('2', '22');
export const italic = code('3', '23');
export const underline = code('4', '24');
export const red = code('31', '39');
export const green = code('32', '39');
export const yellow = code('33', '39');
export const blue = code('34', '39');
export const magenta = code('35', '39');
export const cyan = code('36', '39');
export const white = code('37', '39');
export const gray = code('90', '39');

// Bright variants
export const greenBright = code('92', '39');
export const cyanBright = code('96', '39');
export const yellowBright = code('93', '39');
export const redBright = code('91', '39');

// Background
export const bgGreen = code('42', '49');
export const bgRed = code('41', '49');
export const bgYellow = code('43', '49');
export const bgCyan = code('46', '49');

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export const symbols = {
  check: isColorSupported ? '\u2713' : 'v',
  cross: isColorSupported ? '\u2717' : 'x',
  bullet: isColorSupported ? '\u2022' : '*',
  arrow: isColorSupported ? '\u2192' : '->',
  arrowRight: isColorSupported ? '\u25B8' : '>',
  info: isColorSupported ? '\u2139' : 'i',
  warning: isColorSupported ? '\u26A0' : '!',
  dot: isColorSupported ? '\u2219' : '.',
  line: isColorSupported ? '\u2500' : '-',
  vertLine: isColorSupported ? '\u2502' : '|',
  topLeft: isColorSupported ? '\u256D' : '+',
  topRight: isColorSupported ? '\u256E' : '+',
  bottomLeft: isColorSupported ? '\u2570' : '+',
  bottomRight: isColorSupported ? '\u256F' : '+',
  tee: isColorSupported ? '\u251C' : '|',
  teeEnd: isColorSupported ? '\u2514' : '\\',
} as const;

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export function box(content: string, options?: { title?: string; padding?: number }): string {
  const padding = options?.padding ?? 1;
  const lines = content.split('\n');
  const pad = ' '.repeat(padding);

  // Calculate max width (strip ANSI for measurement)
  const maxWidth = Math.max(
    ...lines.map((l) => stripAnsi(l).length),
    options?.title ? stripAnsi(options.title).length + 2 : 0,
  );
  const innerWidth = maxWidth + padding * 2;

  const top = options?.title
    ? `${symbols.topLeft}${symbols.line} ${options.title} ${symbols.line.repeat(Math.max(0, innerWidth - stripAnsi(options.title).length - 3))}${symbols.topRight}`
    : `${symbols.topLeft}${symbols.line.repeat(innerWidth)}${symbols.topRight}`;

  const bottom = `${symbols.bottomLeft}${symbols.line.repeat(innerWidth)}${symbols.bottomRight}`;

  const body = lines.map((line) => {
    const stripped = stripAnsi(line);
    const rightPad = ' '.repeat(Math.max(0, maxWidth - stripped.length));
    return `${symbols.vertLine}${pad}${line}${rightPad}${pad}${symbols.vertLine}`;
  });

  return [top, ...body, bottom].join('\n');
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

export function table(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => {
      const cell = row[i] ?? '';
      return Math.max(max, stripAnsi(cell).length);
    }, 0);
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const headerLine = headers
    .map((h, i) => {
      const w = colWidths[i]!;
      return ` ${bold(h)}${' '.repeat(Math.max(0, w - stripAnsi(h).length))} `;
    })
    .join(dim(symbols.vertLine));

  const separator = colWidths
    .map((w) => symbols.line.repeat(w + 2))
    .join(dim(symbols.line));

  const bodyLines = rows.map((row) =>
    row
      .map((cell, i) => {
        const w = colWidths[i]!;
        return ` ${cell}${' '.repeat(Math.max(0, w - stripAnsi(cell).length))} `;
      })
      .join(dim(symbols.vertLine)),
  );

  return [headerLine, dim(separator), ...bodyLines].join('\n');
}

// ---------------------------------------------------------------------------
// Spinner (simple dots animation)
// ---------------------------------------------------------------------------

export class Spinner {
  private frames = ['   ', '.  ', '.. ', '...', ' ..', '  .'];
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): this {
    if (!isColorSupported || !process.stdout.isTTY) {
      process.stdout.write(`  ${this.message}...\n`);
      return this;
    }
    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length]!;
      process.stdout.write(`\r  ${cyan(frame)} ${this.message}`);
      this.frameIndex++;
    }, 120);
    return this;
  }

  succeed(msg?: string): void {
    this.stop();
    const text = msg ?? this.message;
    process.stdout.write(`\r  ${green(symbols.check)} ${text}\n`);
  }

  fail(msg?: string): void {
    this.stop();
    const text = msg ?? this.message;
    process.stdout.write(`\r  ${red(symbols.cross)} ${text}\n`);
  }

  info(msg?: string): void {
    this.stop();
    const text = msg ?? this.message;
    process.stdout.write(`\r  ${blue(symbols.info)} ${text}\n`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      // Clear the line
      if (isColorSupported && process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

export function header(text: string): void {
  console.log('');
  console.log(`  ${bold(cyan(text))}`);
  console.log('');
}

export function success(msg: string): void {
  console.log(`  ${green(symbols.check)} ${msg}`);
}

export function error(msg: string): void {
  console.log(`  ${red(symbols.cross)} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow(symbols.warning)} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${blue(symbols.info)} ${msg}`);
}

export function label(key: string, value: string): void {
  console.log(`  ${dim(key + ':')} ${value}`);
}

export function newline(): void {
  console.log('');
}

export function divider(): void {
  const width = Math.min(process.stdout.columns ?? 60, 60);
  console.log(`  ${dim(symbols.line.repeat(width - 4))}`);
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

export function banner(): void {
  console.log('');
  console.log(`  ${bold(cyan('turbine'))} ${dim('by')} ${bold('BataData')}`);
  console.log(`  ${dim('TypeScript ORM with json_agg nested queries')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Elapsed time formatting
// ---------------------------------------------------------------------------

export function elapsed(startMs: number): string {
  const ms = performance.now() - startMs;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Strip ANSI codes (for width calculation)
// ---------------------------------------------------------------------------

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Redact password from connection URL
// ---------------------------------------------------------------------------

export function redactUrl(url: string): string {
  return url.replace(/:([^@/:]+)@/, ':***@');
}
