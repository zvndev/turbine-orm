// Preloaded by collect.mjs, in each Node process/isolate. Never load this in a
// production run. Debugger identities and V8 coverage scriptIds share an isolate.
const { Session } = require('node:inspector');
const { writeFileSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const { fileURLToPath } = require('node:url');
const { threadId, isInternalThread } = require('node:worker_threads');

const directory = process.env.TURBINE_COVERAGE_CAPTURE_DIRECTORY;
if (directory && isInternalThread) {
  // Node's private loader isolate has no V8 inspector. It transforms modules
  // but does not execute the application. Preserve its raw coverage; any
  // included ambiguous script in it still fails closed in the report.
  writeFileSync(resolve(directory, `owner-${process.pid}-${threadId}`), '', { flag: 'wx' });
  writeFileSync(resolve(directory, `maps-${process.pid}-${threadId}.json`), JSON.stringify({
    version: 1, pid: process.pid, threadId, scripts: {}, errors: [], internalLoader: true,
  }));
} else if (directory) {
  (function install() {
    const root = resolve(process.env.TURBINE_COVERAGE_SOURCE_ROOT) + sep;
    const session = new Session();
    const byUrl = new Map();
    const scripts = Object.create(null);
    const errors = [];
    // Exclusive creation prevents a reused PID/isolate in this invocation from
    // replacing an earlier identity table. Staging is unique to collect.mjs.
    writeFileSync(resolve(directory, `owner-${process.pid}-${threadId}`), '', { flag: 'wx' });
    try {
      session.connect();
    } catch (error) {
      // The --test coordinator also has no inspector on Node 22. Its raw entry
      // remains intact, and any included collision without identities is fatal.
      writeFileSync(resolve(directory, `maps-${process.pid}-${threadId}.json`), JSON.stringify({
        version: 1, pid: process.pid, threadId, scripts: {}, errors: [], unavailableInspector: String(error),
      }));
      return;
    }

    function persist() {
      writeFileSync(resolve(directory, `maps-${process.pid}-${threadId}.json`), JSON.stringify({
        version: 1, pid: process.pid, threadId, scripts, errors,
      }));
    }

    // Inspector posts on a same-thread Session complete synchronously. Refuse to
    // emit an attribution if a runtime changes that behaviour.
    function post(method, params) {
      let complete = false;
      let result;
      let failure;
      session.post(method, params, (error, value) => {
        complete = true;
        failure = error;
        result = value;
      });
      if (!complete || failure) throw failure ?? new Error(`asynchronous ${method}`);
      return result;
    }

    function capture(event) {
      if (scripts[event.scriptId]) return;
      const captured = { url: event.url };
      scripts[event.scriptId] = captured;
      try {
        captured.source = post('Debugger.getScriptSource', { scriptId: event.scriptId }).scriptSource;
        captured.sourceMap = null;
        if (event.sourceMapURL) {
          let text;
          if (event.sourceMapURL.startsWith('data:')) {
            const comma = event.sourceMapURL.indexOf(',');
            if (comma < 0) throw new Error('malformed inline source map');
            const header = event.sourceMapURL.slice(0, comma);
            const data = event.sourceMapURL.slice(comma + 1);
            text = /;base64$/i.test(header) ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
          } else throw new Error('collision capture requires an inline source map');
          const data = JSON.parse(text);
          if (data.version !== 3 || (!data.mappings && data.mappings !== '') || !Array.isArray(data.sources)) {
            throw new Error('unsupported source map');
          }
          captured.sourceMap = { data };
        }
      } catch (error) {
        captured.error = String(error);
      }
    }

    session.on('Debugger.scriptParsed', ({ params: event }) => {
      try {
        if (!event.url.startsWith('file:') || !fileURLToPath(event.url).startsWith(root)) return;
        const previous = byUrl.get(event.url) ?? [];
        // Unique URLs retain Node's existing cache and absence semantics. Only
        // collisions need generated source/map payloads, keeping this bounded.
        if (previous.length) {
          for (const script of previous) capture(script);
          capture(event);
          // Worker termination need not emit 'exit'. Persist identities while
          // the isolate is alive, before Node flushes that worker's coverage.
          persist();
        }
        previous.push({ scriptId: event.scriptId, url: event.url, sourceMapURL: event.sourceMapURL });
        byUrl.set(event.url, previous);
      } catch (error) {
        errors.push(String(error));
        persist();
      }
    });
    persist();
    post('Debugger.enable', {});

    // Node still owns coverage collection and its normal final flush. The parent
    // waits for exit, then binds these maps to the raw file from this process and
    // thread. No PID/time guess is used when the report consumes the artifact.
    process.on('exit', persist);
  })();
}
