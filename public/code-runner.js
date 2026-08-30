/**
 * Real Multi-Language Code Execution Engine
 * Supports 4 Languages: Python, Java, C, and C++ (with JavaScript support)
 * Native server-side compiler toolchain (OpenJDK 17, GCC, G++, Python 3) with in-browser fallback.
 */

// Global cache for in-browser Python (Skulpt)
let skulptPromise = null;

function loadSkulpt() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.Sk) return Promise.resolve(window.Sk);
  if (skulptPromise) return skulptPromise;

  skulptPromise = new Promise((resolve, reject) => {
    const script1 = document.createElement('script');
    script1.src = 'https://cdn.jsdelivr.net/npm/skulpt@1.2.0/dist/skulpt.min.js';
    script1.onload = () => {
      const script2 = document.createElement('script');
      script2.src = 'https://cdn.jsdelivr.net/npm/skulpt@1.2.0/dist/skulpt-stdlib.js';
      script2.onload = () => resolve(window.Sk);
      script2.onerror = () => resolve(window.Sk);
      document.head.appendChild(script2);
    };
    script1.onerror = () => reject(new Error('Failed to load in-browser Python runtime'));
    document.head.appendChild(script1);
  });

  return skulptPromise;
}

if (typeof window !== 'undefined') {
  setTimeout(() => {
    loadSkulpt().catch(() => {});
  }, 500);
}

/**
 * Executes code via server compiler toolchains (OpenJDK javac/java, gcc, g++, python3)
 * with robust client-side online compiler and in-browser fallback engine.
 * @param {string} language - 'python' | 'java' | 'c' | 'cpp' | 'javascript'
 * @param {string} code - source code written by student
 * @param {string} stdin - standard input string
 * @param {number} timeoutMs - max execution time in ms (default 6000ms)
 * @returns {Promise<{ output: string, error?: string, executionTimeMs: number }>}
 */
export async function executeCodeInBrowser(language, code, stdin = '', timeoutMs = 6000) {
  const startTime = performance.now();
  const rawLang = (language || 'python').toLowerCase().trim();
  let lang = rawLang;
  if (lang === 'py') lang = 'python';
  if (lang === 'c++') lang = 'cpp';
  if (lang === 'js') lang = 'javascript';

  // 1. Primary: execute on backend compiler/runtime toolchain
  try {
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), timeoutMs + 4000);
    const res = await fetch('/api/run-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang, code, stdin, timeoutMs }),
      signal: controller.signal
    });
    clearTimeout(fetchTimer);

    if (res.ok) {
      const data = await res.json();
      return {
        output: data.output || '',
        error: data.error || null,
        executionTimeMs: data.executionTimeMs || Math.round(performance.now() - startTime)
      };
    }
  } catch (err) {
    // Backend call unreachable or network timeout, fall back to direct compiler below
  }

  // 2. Secondary: Direct Wandbox execution from browser (if server is offline or proxy is blocked)
  try {
    let compiler = 'cpython-3.12.7';
    let codeToSend = code;
    if (lang === 'java') {
      compiler = 'openjdk-jdk-22+36';
      codeToSend = code.replace(/\bpublic\s+class\b/g, 'class');
    } else if (lang === 'c') {
      compiler = 'gcc-13.2.0-c';
    } else if (lang === 'cpp') {
      compiler = 'gcc-13.2.0';
    } else if (lang === 'javascript') {
      compiler = 'nodejs-20.17.0';
    }

    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), timeoutMs + 4000);
    const wandboxRes = await fetch('https://wandbox.org/api/compile.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compiler, code: codeToSend, stdin: String(stdin || '') }),
      signal: controller.signal
    });
    clearTimeout(fetchTimer);

    if (wandboxRes.ok) {
      const data = await wandboxRes.json();
      const executionTimeMs = Math.round(performance.now() - startTime);

      if (data.compiler_error || (data.status !== '0' && data.status !== 0 && !data.program_output && !data.program_error)) {
        return {
          output: `Compilation Error:\n${(data.compiler_error || data.compiler_message || '').trim()}`,
          error: 'Compilation Error',
          executionTimeMs
        };
      }

      let out = data.program_output || '';
      if (data.program_error) {
        out = (out ? out + '\n' : '') + data.program_error;
      } else if (data.program_message && !out) {
        out = data.program_message;
      }

      return {
        output: (out || '').replace(/\r\n/g, '\n'),
        error: data.program_error ? 'Runtime Error' : null,
        executionTimeMs
      };
    }
  } catch (wandboxErr) {
    // Wandbox unreachable, fall back to in-browser offline engine
  }

  // 3. Tertiary: In-Browser execution fallback (offline mode)
  if (lang === 'python') {
    return runPythonInBrowser(code, stdin, timeoutMs, startTime);
  } else if (lang === 'java') {
    return runJavaInBrowser(code, stdin, timeoutMs, startTime);
  } else if (lang === 'c' || lang === 'cpp') {
    return runCInBrowser(code, stdin, timeoutMs, startTime);
  } else if (lang === 'javascript') {
    return runJavaScriptInBrowser(code, stdin, timeoutMs, startTime);
  }

  // Final Fallback
  return runJavaInBrowser(code, stdin, timeoutMs, startTime);
}

/**
 * 1. JavaScript Runner using Web Worker
 */
function runJavaScriptInBrowser(code, stdin, timeoutMs, startTime) {
  return new Promise((resolve) => {
    const workerScript = `
      self.onmessage = function(e) {
        const { code, stdin } = e.data;
        let stdout = '';
        let stderr = '';

        const rawInput = stdin || '';
        const lines = rawInput.split(/\\r?\\n/);
        let lineIdx = 0;

        function readline() {
          if (lineIdx < lines.length) return lines[lineIdx++];
          return '';
        }

        const input = function() { return readline(); };

        const fs = {
          readFileSync: function() { return rawInput; }
        };

        const require = function(mod) {
          if (mod === 'fs') return fs;
          return {};
        };

        const process = {
          stdin: { read: function() { return rawInput; } },
          stdout: { write: function(s) { stdout += String(s); } }
        };

        const customConsole = {
          log: function(...args) {
            stdout += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n';
          },
          error: function(...args) { stderr += args.map(a => String(a)).join(' ') + '\\n'; },
          warn: function(...args) { stdout += args.map(a => String(a)).join(' ') + '\\n'; },
          info: function(...args) { stdout += args.map(a => String(a)).join(' ') + '\\n'; }
        };

        try {
          const runner = new Function('console', 'readline', 'input', 'require', 'fs', 'process', 'stdin', 'lines', code);
          const result = runner(customConsole, readline, input, require, fs, process, rawInput, lines);
          if (result !== undefined && stdout.trim().length === 0) {
            stdout = String(result) + '\\n';
          }
          self.postMessage({ success: true, stdout, stderr });
        } catch (err) {
          self.postMessage({ success: false, error: err.stack || err.message || String(err), stdout, stderr });
        }
      };
    `;

    executeWorkerCode(workerScript, { code, stdin }, timeoutMs, startTime, resolve);
  });
}

/**
 * 2. Python Runner using Skulpt
 */
async function runPythonInBrowser(code, stdin, timeoutMs, startTime) {
  try {
    await loadSkulpt();
  } catch (err) {
    return {
      output: 'In-browser Python engine loading failed. Please check your internet connection.',
      error: 'Python engine unavailable',
      executionTimeMs: 0
    };
  }

  return new Promise((resolve) => {
    let stdout = '';
    const rawInput = stdin || '';
    const lines = rawInput.split(/\r?\n/);
    let lineIdx = 0;

    function builtinRead(x) {
      if (window.Sk.builtinFiles === undefined || window.Sk.builtinFiles["files"][x] === undefined) {
        throw new Error("File not found: '" + x + "'");
      }
      return window.Sk.builtinFiles["files"][x];
    }

    window.Sk.configure({
      output: function(text) { stdout += text; },
      read: builtinRead,
      inputfun: function() {
        if (lineIdx < lines.length) return lines[lineIdx++];
        return '';
      },
      inputfunTakesPrompt: true,
      execLimit: timeoutMs,
      __future__: window.Sk.python3
    });

    let runnableCode = `
import sys
class _CustomStdin:
    def __init__(self, raw):
        self._raw = raw
        self._lines = raw.splitlines(True)
        self._l_idx = 0
    def read(self, *a):
        return self._raw
    def readline(self, *a):
        if self._l_idx < len(self._lines):
            res = self._lines[self._l_idx]
            self._l_idx += 1
            return res
        return ''
    def readlines(self, *a):
        return self._lines

sys.stdin = _CustomStdin(${JSON.stringify(rawInput)})
\n` + code;

    const promise = window.Sk.misceval.asyncToPromise(() => {
      return window.Sk.importMainWithBody("<stdin>", false, runnableCode, true);
    });

    let isDone = false;
    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        const execTime = Math.round(performance.now() - startTime);
        resolve({
          output: `Error: Time Limit Exceeded (${timeoutMs}ms). Check for infinite loops.`,
          error: 'Time Limit Exceeded',
          executionTimeMs: execTime
        });
      }
    }, timeoutMs);

    promise.then(() => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      const execTime = Math.round(performance.now() - startTime);
      resolve({
        output: stdout.replace(/\r\n/g, '\n'),
        executionTimeMs: execTime
      });
    }).catch((err) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      const execTime = Math.round(performance.now() - startTime);
      resolve({
        output: (stdout ? stdout + '\n' : '') + (err.toString() || 'Python execution error'),
        error: err.toString(),
        executionTimeMs: execTime
      });
    });
  });
}

/**
 * 3. Java In-Browser Transpiler & Execution Runner
 * Transpiles Java solutions (Scanner, StringBuilder, System.out.println, arrays, loops, methods)
 * into safe sandboxed execution in Web Worker.
 */
function runJavaInBrowser(code, stdin, timeoutMs, startTime) {
  const jsConverted = transpileJavaToJS(code);
  return new Promise((resolve) => {
    const workerScript = `
      self.onmessage = function(e) {
        const { code, stdin } = e.data;
        let stdout = '';
        let stderr = '';

        const rawInput = stdin || '';
        const tokens = rawInput.trim().split(/\\s+/).filter(Boolean);
        const lines = rawInput.split(/\\r?\\n/);
        let tokenIdx = 0;
        let lineIdx = 0;

        class Scanner {
          constructor() {}
          hasNext() { return tokenIdx < tokens.length; }
          hasNextInt() { return tokenIdx < tokens.length && !isNaN(parseInt(tokens[tokenIdx], 10)); }
          hasNextDouble() { return tokenIdx < tokens.length && !isNaN(parseFloat(tokens[tokenIdx])); }
          hasNextLine() { return lineIdx < lines.length; }
          next() { return tokenIdx < tokens.length ? tokens[tokenIdx++] : ''; }
          nextLine() { return lineIdx < lines.length ? lines[lineIdx++] : ''; }
          nextInt() { return tokenIdx < tokens.length ? parseInt(tokens[tokenIdx++], 10) : 0; }
          nextDouble() { return tokenIdx < tokens.length ? parseFloat(tokens[tokenIdx++]) : 0.0; }
          nextFloat() { return tokenIdx < tokens.length ? parseFloat(tokens[tokenIdx++]) : 0.0; }
          nextLong() { return tokenIdx < tokens.length ? parseInt(tokens[tokenIdx++], 10) : 0; }
          close() {}
        }

        class StringBuilder {
          constructor(str = '') { this._str = String(str); }
          append(v) { this._str += String(v !== undefined ? v : ''); return this; }
          reverse() { this._str = this._str.split('').reverse().join(''); return this; }
          toString() { return this._str; }
          length() { return this._str.length; }
          get length() { return this._str.length; }
          charAt(i) { return this._str.charAt(i); }
          substring(s, e) { return this._str.substring(s, e); }
        }
        const StringBuffer = StringBuilder;

        const System = {
          in: {},
          out: {
            println: function(arg = '') {
              stdout += (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)) + '\\n';
            },
            print: function(arg = '') {
              stdout += (typeof arg === 'object' ? JSON.stringify(arg) : String(arg));
            },
            printf: function(fmt, ...args) {
              let i = 0;
              const res = String(fmt).replace(/%[0-9.]*[sdfc]/g, () => (i < args.length ? String(args[i++]) : ''));
              stdout += res;
            }
          },
          err: {
            println: function(arg = '') { stderr += String(arg) + '\\n'; }
          }
        };

        class ArrayList {
          constructor() { this._items = []; }
          add(item) { this._items.push(item); return true; }
          get(i) { return this._items[i]; }
          set(i, val) { this._items[i] = val; }
          remove(i) { return typeof i === 'number' ? this._items.splice(i, 1)[0] : this._items.splice(this._items.indexOf(i), 1)[0]; }
          size() { return this._items.length; }
          get length() { return this._items.length; }
          isEmpty() { return this._items.length === 0; }
          contains(item) { return this._items.includes(item); }
          clear() { this._items = []; }
          toArray() { return [...this._items]; }
          [Symbol.iterator]() { return this._items[Symbol.iterator](); }
        }

        class HashMap {
          constructor() { this._map = new Map(); }
          put(k, v) { this._map.set(k, v); }
          get(k) { return this._map.has(k) ? this._map.get(k) : null; }
          getOrDefault(k, def) { return this._map.has(k) ? this._map.get(k) : def; }
          containsKey(k) { return this._map.has(k); }
          remove(k) { return this._map.delete(k); }
          size() { return this._map.size; }
          keySet() { return Array.from(this._map.keys()); }
          values() { return Array.from(this._map.values()); }
          clear() { this._map.clear(); }
        }

        class HashSet {
          constructor() { this._set = new Set(); }
          add(item) { this._set.add(item); return true; }
          contains(item) { return this._set.has(item); }
          remove(item) { return this._set.delete(item); }
          size() { return this._set.size; }
          isEmpty() { return this._set.size === 0; }
          clear() { this._set.clear(); }
          [Symbol.iterator]() { return this._set[Symbol.iterator](); }
        }

        const Arrays = {
          sort: function(arr, cmp) {
            if (Array.isArray(arr)) {
              if (cmp) arr.sort(cmp);
              else arr.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
            }
          },
          fill: function(arr, val) { if (Array.isArray(arr)) arr.fill(val); },
          toString: function(arr) { return JSON.stringify(arr); }
        };

        const Collections = {
          sort: function(list, cmp) {
            const arr = list instanceof ArrayList ? list._items : list;
            Arrays.sort(arr, cmp);
          },
          reverse: function(list) {
            const arr = list instanceof ArrayList ? list._items : list;
            if (Array.isArray(arr)) arr.reverse();
          },
          max: function(list) {
            const arr = list instanceof ArrayList ? list._items : list;
            return Math.max(...arr);
          },
          min: function(list) {
            const arr = list instanceof ArrayList ? list._items : list;
            return Math.min(...arr);
          }
        };

        const Integer = {
          parseInt: function(s) { return parseInt(s, 10); },
          toString: function(n, r = 10) { return (n).toString(r); },
          toBinaryString: function(n) { return (n).toString(2); },
          toHexString: function(n) { return (n).toString(16); },
          min: Math.min, max: Math.max,
          MAX_VALUE: 2147483647,
          MIN_VALUE: -2147483648
        };

        const Double = {
          parseDouble: function(s) { return parseFloat(s); },
          toString: function(n) { return String(n); },
          MAX_VALUE: Number.MAX_VALUE,
          MIN_VALUE: Number.MIN_VALUE
        };

        const Character = {
          isDigit: function(c) { return /\\d/.test(String(c)); },
          isLetter: function(c) { return /[a-zA-Z]/.test(String(c)); },
          toLowerCase: function(c) { return String(c).toLowerCase(); },
          toUpperCase: function(c) { return String(c).toUpperCase(); }
        };

        // Prototypes
        try {
          String.prototype.equals = function(o) { return this.valueOf() === (o != null ? o.valueOf() : null); };
          String.prototype.equalsIgnoreCase = function(o) { return this.toLowerCase() === (o != null ? String(o).toLowerCase() : null); };
          String.prototype.toCharArray = function() { return this.split(''); };
          String.prototype.contains = function(sub) { return this.includes(sub); };
          String.prototype.compareTo = function(o) { return this.localeCompare(o); };
          String.prototype.isEmpty = function() { return this.length === 0; };
        } catch (e) {}

        const MathUtils = Object.assign({}, Math, {
          max: Math.max, min: Math.min, abs: Math.abs, sqrt: Math.sqrt, pow: Math.pow,
          floor: Math.floor, ceil: Math.ceil, round: Math.round, PI: Math.PI
        });

        try {
          const runner = new Function(
            'Scanner', 'StringBuilder', 'StringBuffer', 'System', 'Math', 'Arrays', 'Collections',
            'ArrayList', 'HashMap', 'HashSet', 'Integer', 'Double', 'Character', 'rawInput', 'tokens',
            code
          );
          runner(
            Scanner, StringBuilder, StringBuffer, System, MathUtils, Arrays, Collections,
            ArrayList, HashMap, HashSet, Integer, Double, Character, rawInput, tokens
          );
          self.postMessage({ success: true, stdout, stderr });
        } catch (err) {
          self.postMessage({ success: false, error: err.stack || err.message || String(err), stdout, stderr });
        }
      };
    `;

    executeWorkerCode(workerScript, { code: jsConverted, stdin }, timeoutMs, startTime, resolve);
  });
}

/**
 * 4. C In-Browser Transpiler & Execution Runner
 */
function runCInBrowser(code, stdin, timeoutMs, startTime) {
  const jsConverted = transpileCToJS(code);
  return new Promise((resolve) => {
    const workerScript = `
      self.onmessage = function(e) {
        const { code, stdin } = e.data;
        let stdout = '';
        let stderr = '';

        const rawInput = stdin || '';
        const tokens = rawInput.trim().split(/\\s+/).filter(Boolean);
        const lines = rawInput.split(/\\r?\\n/);
        let tokenIdx = 0;
        let lineIdx = 0;

        function printf(fmt, ...args) {
          if (fmt === undefined || fmt === null) return;
          let s = String(fmt);
          let argIdx = 0;
          s = s.replace(/%[0-9.]*[sdfciluxX%]/g, (match) => {
            if (match === '%%') return '%';
            if (argIdx >= args.length) return match;
            const val = args[argIdx++];
            if (match.endsWith('f')) {
              const precMatch = match.match(/\\.([0-9]+)f/);
              if (precMatch) return Number(val).toFixed(parseInt(precMatch[1], 10));
              return String(val);
            }
            return String(val);
          });
          stdout += s;
        }

        function puts(s) { stdout += String(s) + '\\n'; }
        function putchar(c) {
          if (typeof c === 'number') stdout += String.fromCharCode(c);
          else stdout += String(c);
        }
        function gets() { return lineIdx < lines.length ? lines[lineIdx++] : ''; }

        function strlen(s) { return (typeof s === 'string' || Array.isArray(s)) ? s.length : 0; }
        function strcmp(s1, s2) { return String(s1).localeCompare(String(s2)); }
        function strcpy(dest, src) { return String(src); }
        function strcat(dest, src) { return String(dest) + String(src); }
        function tolower(c) { return String.fromCharCode(typeof c === 'number' ? c : c.charCodeAt(0)).toLowerCase(); }
        function toupper(c) { return String.fromCharCode(typeof c === 'number' ? c : c.charCodeAt(0)).toUpperCase(); }
        function isdigit(c) { const ch = typeof c === 'number' ? String.fromCharCode(c) : String(c); return /\\d/.test(ch); }
        function isalpha(c) { const ch = typeof c === 'number' ? String.fromCharCode(c) : String(c); return /[a-zA-Z]/.test(ch); }
        function abs(x) { return Math.abs(x); }
        function sqrt(x) { return Math.sqrt(x); }
        function pow(x, y) { return Math.pow(x, y); }
        function floor(x) { return Math.floor(x); }
        function ceil(x) { return Math.ceil(x); }

        try {
          const runner = new Function(
            'printf', 'puts', 'putchar', 'gets', 'strlen', 'strcmp', 'strcpy', 'strcat',
            'tolower', 'toupper', 'isdigit', 'isalpha', 'abs', 'sqrt', 'pow', 'floor', 'ceil',
            'rawInput', 'tokens', 'tokenIdx',
            code
          );
          runner(
            printf, puts, putchar, gets, strlen, strcmp, strcpy, strcat,
            tolower, toupper, isdigit, isalpha, abs, sqrt, pow, floor, ceil,
            rawInput, tokens, tokenIdx
          );
          self.postMessage({ success: true, stdout, stderr });
        } catch (err) {
          self.postMessage({ success: false, error: err.stack || err.message || String(err), stdout, stderr });
        }
      };
    `;

    executeWorkerCode(workerScript, { code: jsConverted, stdin }, timeoutMs, startTime, resolve);
  });
}

function executeWorkerCode(workerScript, data, timeoutMs, startTime, resolve) {
  const blob = new Blob([workerScript], { type: 'application/javascript' });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl);

  let isCompleted = false;

  const timer = setTimeout(() => {
    if (!isCompleted) {
      isCompleted = true;
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      const execTime = Math.round(performance.now() - startTime);
      resolve({
        output: `Error: Time Limit Exceeded (${timeoutMs}ms). Check for infinite loops.`,
        error: 'Time Limit Exceeded',
        executionTimeMs: execTime
      });
    }
  }, timeoutMs);

  worker.onmessage = function(e) {
    if (isCompleted) return;
    isCompleted = true;
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(workerUrl);

    const execTime = Math.round(performance.now() - startTime);
    const res = e.data;
    if (!res.success) {
      resolve({
        output: (res.stdout || '') + (res.stdout ? '\n' : '') + (res.error || 'Execution Error'),
        error: res.error,
        executionTimeMs: execTime
      });
    } else {
      resolve({
        output: (res.stdout || '').replace(/\r\n/g, '\n'),
        executionTimeMs: execTime
      });
    }
  };

  worker.onerror = function(err) {
    if (isCompleted) return;
    isCompleted = true;
    clearTimeout(timer);
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    resolve({
      output: 'Syntax/Runtime Error: ' + (err.message || 'Error executing script'),
      error: err.message,
      executionTimeMs: Math.round(performance.now() - startTime)
    });
  };

  worker.postMessage(data);
}

// Java to JS lightweight transpiler for student coding problems
function transpileJavaToJS(javaCode) {
  let js = javaCode;

  // 1. Strip package and imports
  js = js.replace(/package\s+[a-zA-Z0-9_.]+;/g, '');
  js = js.replace(/import\s+[a-zA-Z0-9_.*]+;/g, '');

  // 2. Class definition & main method
  // Replace "public class Main" -> "class Main"
  js = js.replace(/\bpublic\s+class\s+(\w+)/g, 'class $1');

  // Convert "public static void main(String[] args)" -> "static main(args)"
  js = js.replace(/(?:public|private|protected)?\s*static\s+(?:void|[a-zA-Z0-9_<>[\]]+)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*\{/g, (match, mName, params) => {
    const cleanParams = params.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      return parts[parts.length - 1] || '';
    }).filter(Boolean).join(', ');
    return `static ${mName}(${cleanParams}) {`;
  });

  // Convert instance methods
  js = js.replace(/(?:public|private|protected)?\s+(?:void|int|long|float|double|boolean|char|String|[A-Z][a-zA-Z0-9_]*)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*\{/g, (match, mName, params) => {
    if (['if', 'for', 'while', 'switch', 'catch'].includes(mName)) return match;
    const cleanParams = params.split(',').map(p => {
      const parts = p.trim().split(/\s+/);
      return parts[parts.length - 1] || '';
    }).filter(Boolean).join(', ');
    return `${mName}(${cleanParams}) {`;
  });

  // 3. For loops: for (int i = 0; ...) or for (String s : list)
  js = js.replace(/for\s*\(\s*(?:final\s+)?(?:[a-zA-Z0-9_<>[\]]+)\s+([a-zA-Z0-9_]+)\s*:\s*([^)]+)\)/g, 'for (let $1 of $2)');
  js = js.replace(/for\s*\(\s*(?:final\s+)?(?:[a-zA-Z0-9_<>[\]]+)\s+([a-zA-Z0-9_]+)\s*=/g, 'for (let $1 =');

  // 4. Handle new Type[size] -> new Array(size).fill(0)
  js = js.replace(/new\s+[a-zA-Z0-9_]+\s*\[([^\]]+)\]/g, 'new Array($1).fill(0)');
  // Handle new Type<...>() -> new Type()
  js = js.replace(/new\s+([a-zA-Z0-9_]+)\s*<[^>]*>\s*\(/g, 'new $1(');

  // 5. Variable declarations (Scanner sc = ..., int a = ..., String s = ...)
  const typePattern = /\b(?:final\s+)?(?:int|long|float|double|boolean|char|short|byte|String|Scanner|StringBuilder|StringBuffer|Integer|Double|Boolean|Character|Long|Float|Object|ArrayList|List|Map|HashMap|Set|HashSet|Vector|Stack|Queue|ArrayDeque|BufferedReader|InputStreamReader|[A-Z][a-zA-Z0-9_]*)(?:<[^>]*>)?(?:\s*\[\s*\])*\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(=|;|,)/g;
  js = js.replace(typePattern, 'let $1 $2');

  // Handle multi-variable declarations
  js = js.replace(/\blet\s+([a-zA-Z0-9_]+)\s*,\s*([a-zA-Z0-9_]+)\s*;/g, 'let $1 = 0, $2 = 0;');
  js = js.replace(/\blet\s+([a-zA-Z0-9_]+)\s*;/g, 'let $1 = 0;');

  // 6. String length
  js = js.replace(/\.length\(\)/g, '.length');

  // 7. Auto-invoke Main.main if class exists
  js += `\nif (typeof Main !== 'undefined' && typeof Main.main === 'function') { Main.main([]); }\n`;
  js += `else if (typeof Solution !== 'undefined' && typeof Solution.main === 'function') { Solution.main([]); }\n`;

  return js;
}

// C to JS lightweight transpiler for student coding problems
function transpileCToJS(cCode) {
  let js = cCode;

  // 1. Strip #include lines
  js = js.replace(/#include\s*<[^>]+>/g, '');
  js = js.replace(/#include\s*"[^"]+"/g, '');

  // 2. Convert main function
  js = js.replace(/int\s+main\s*\([^)]*\)\s*\{/g, 'function _c_main() {');

  // 3. Handle scanf conversions:
  // Supports: scanf("%d %d", &a, &b), scanf("%s", s), scanf("%c", &ch), etc.
  js = js.replace(/scanf\s*\(\s*"([^"]+)"\s*,?\s*([^)]*)\)/g, (match, fmt, argsStr) => {
    const args = argsStr.split(',').map(a => a.trim().replace(/^&/, '')).filter(Boolean);
    const specifiers = fmt.match(/%[0-9.]*[sdfc]/g) || [];
    
    let assigns = [];
    for (let i = 0; i < args.length; i++) {
      const varName = args[i];
      const spec = specifiers[i] || '%s';
      if (spec.includes('d') || spec.includes('i')) {
        assigns.push(`if (tokenIdx < tokens.length) { ${varName} = parseInt(tokens[tokenIdx++], 10); _cnt++; }`);
      } else if (spec.includes('f')) {
        assigns.push(`if (tokenIdx < tokens.length) { ${varName} = parseFloat(tokens[tokenIdx++]); _cnt++; }`);
      } else if (spec.includes('c')) {
        assigns.push(`if (tokenIdx < tokens.length) { ${varName} = (tokens[tokenIdx] ? tokens[tokenIdx++][0] : ''); _cnt++; }`);
      } else {
        // String / %s
        assigns.push(`if (tokenIdx < tokens.length) { ${varName} = tokens[tokenIdx++]; _cnt++; }`);
      }
    }
    return `((function() { let _cnt = 0; ${assigns.join(' ')} return _cnt; })())`;
  });

  // 4. For loops: for (int i = 0; ...)
  js = js.replace(/for\s*\(\s*(?:int|long|float|double|char|short|size_t)\s+([a-zA-Z0-9_]+)\s*=/g, 'for (let $1 =');

  // 5. Type declarations
  // Arrays: int arr[100]; -> let arr = new Array(100).fill(0);
  js = js.replace(/\b(?:int|long|float|double|short)\s+([a-zA-Z0-9_]+)\s*\[([^\]]+)\]\s*;/g, 'let $1 = new Array($2).fill(0);');
  // char s[100]; -> let s = "";
  js = js.replace(/\bchar\s+([a-zA-Z0-9_]+)\s*\[([^\]]+)\]\s*;/g, 'let $1 = "";');
  js = js.replace(/\bchar\s+([a-zA-Z0-9_]+)\s*\[([^\]]+)\]\s*=\s*([^;]+);/g, 'let $1 = $3;');

  // Primitives: int a = 5, b = 10;
  js = js.replace(/\b(?:int|long|float|double|char|short|size_t)\s+([a-zA-Z0-9_]+)\s*(=|;|,)/g, 'let $1 $2');
  js = js.replace(/\blet\s+([a-zA-Z0-9_]+)\s*,\s*([a-zA-Z0-9_]+)\s*;/g, 'let $1 = 0, $2 = 0;');
  js = js.replace(/\blet\s+([a-zA-Z0-9_]+)\s*;/g, 'let $1 = 0;');

  // 6. Return 0 in main
  js = js.replace(/return\s+0\s*;/g, '');

  // 7. Auto invoke _c_main
  js += `\nif (typeof _c_main === 'function') { _c_main(); }\n`;

  return js;
}

if (typeof window !== 'undefined') {
  window.executeCodeInBrowser = executeCodeInBrowser;
}
