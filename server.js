import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '20mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const GITHUB_CONFIG_FILE = path.join(DATA_DIR, 'github-config.json');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const TESTS_STORE_FILE = path.join(__dirname, 'tests_store.json');
const TESTS_DIR = path.join(DATA_DIR, 'tests');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const STUDENTS_DIR = path.join(DATA_DIR, 'students');
if (!fs.existsSync(STUDENTS_DIR)) {
  fs.mkdirSync(STUDENTS_DIR, { recursive: true });
}
if (!fs.existsSync(TESTS_DIR)) {
  fs.mkdirSync(TESTS_DIR, { recursive: true });
}

// Helpers for persistent multi-test store
async function getTestsStore() {
  try {
    if (fs.existsSync(TESTS_STORE_FILE)) {
      const content = await fs.promises.readFile(TESTS_STORE_FILE, 'utf-8');
      return JSON.parse(content || '{}');
    }
  } catch (err) {
    console.error('Error reading tests_store.json:', err);
  }
  return { activeTestId: 'default', tests: {} };
}

async function saveTestsStore(store) {
  try {
    await fs.promises.writeFile(TESTS_STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving tests_store.json:', err);
  }
}

// Initial bootstrap and sync between tests_store.json, tests directory, and questions.json
async function ensureDefaultTestExists() {
  try {
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};

    // 1. If questions.json exists, ensure default is in store
    if (fs.existsSync(QUESTIONS_FILE)) {
      try {
        const qContent = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
        const qData = JSON.parse(qContent);
        if (!store.tests['default']) {
          store.tests['default'] = qData;
        }
      } catch (e) {}
    }

    // 2. Ensure all tests in store exist in TESTS_DIR
    for (const [id, testObj] of Object.entries(store.tests)) {
      const testFilePath = path.join(TESTS_DIR, `${id}.json`);
      if (!fs.existsSync(testFilePath)) {
        await fs.promises.writeFile(testFilePath, JSON.stringify(testObj, null, 2), 'utf-8');
      }
    }

    // 3. Ensure all test files in TESTS_DIR exist in store
    if (fs.existsSync(TESTS_DIR)) {
      const files = await fs.promises.readdir(TESTS_DIR);
      for (const f of files) {
        if (f.endsWith('.json')) {
          const id = f.replace('.json', '');
          if (!store.tests[id]) {
            try {
              const content = await fs.promises.readFile(path.join(TESTS_DIR, f), 'utf-8');
              store.tests[id] = JSON.parse(content);
            } catch (e) {}
          }
        }
      }
    }

    // 4. Save synced store
    await saveTestsStore(store);

    // 5. Ensure active test in questions.json is valid
    const defaultTestPath = path.join(TESTS_DIR, 'default.json');
    if (!fs.existsSync(defaultTestPath) && store.tests['default']) {
      await fs.promises.writeFile(defaultTestPath, JSON.stringify(store.tests['default'], null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('Error bootstrapping multi-test storage:', e);
  }
}
ensureDefaultTestExists();

// Helpers for data read/write
async function getSubmissions() {
  try {
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const content = await fs.promises.readFile(SUBMISSIONS_FILE, 'utf-8');
      return JSON.parse(content || '{}');
    }
  } catch (err) {
    console.error('Error reading submissions:', err);
  }
  return {};
}

async function saveSubmissions(subs) {
  await fs.promises.writeFile(SUBMISSIONS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
}

async function getGithubConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(GITHUB_CONFIG_FILE)) {
      const content = await fs.promises.readFile(GITHUB_CONFIG_FILE, 'utf-8');
      fileCfg = JSON.parse(content || '{}');
    }
  } catch (err) {
    console.error('Error reading github config:', err);
  }
  return {
    owner: process.env.GITHUB_OWNER || fileCfg.owner || 'jegadeeshfairness28',
    repo: process.env.GITHUB_REPO || fileCfg.repo || 'test-portal',
    branch: process.env.GITHUB_BRANCH || fileCfg.branch || 'main',
    token: process.env.GITHUB_TOKEN || fileCfg.token || ''
  };
}

async function saveGithubConfig(cfg) {
  await fs.promises.writeFile(GITHUB_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// Helper to push a file to GitHub via REST API
async function pushFileToGitHub(owner, repo, branch, filePath, fileContent, commitMsg, token) {
  if (!token || !owner || !repo) {
    return { success: false, error: 'GitHub credentials or repository details missing.' };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'ClassTestPortal',
    'Authorization': `Bearer ${token}`
  };

  let sha = undefined;
  try {
    const getRes = await fetch(url + `?ref=${branch || 'main'}`, { headers });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }
  } catch (e) {
    // File may not exist yet
  }

  const base64Content = Buffer.from(fileContent).toString('base64');
  const body = {
    message: commitMsg || `Update ${filePath}`,
    content: base64Content,
    branch: branch || 'main'
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    return { success: false, error: `GitHub API error (${putRes.status}): ${errText}` };
  }

  const resData = await putRes.json();
  return { success: true, data: resData };
}

// Background automatic synchronization to GitHub
async function autoSyncToGitHub(reason = 'Portal update') {
  try {
    const ghCfg = await getGithubConfig();
    if (!ghCfg.token || !ghCfg.owner || !ghCfg.repo) return;

    // 1. Sync questions.json
    if (fs.existsSync(QUESTIONS_FILE)) {
      const qContent = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
      await pushFileToGitHub(
        ghCfg.owner,
        ghCfg.repo,
        ghCfg.branch || 'main',
        'questions.json',
        qContent,
        `Auto-sync: update questions.json (${reason})`,
        ghCfg.token
      );
    }

    // 2. Sync tests_store.json
    if (fs.existsSync(TESTS_STORE_FILE)) {
      const tsContent = await fs.promises.readFile(TESTS_STORE_FILE, 'utf-8');
      await pushFileToGitHub(
        ghCfg.owner,
        ghCfg.repo,
        ghCfg.branch || 'main',
        'tests_store.json',
        tsContent,
        `Auto-sync: update tests_store.json (${reason})`,
        ghCfg.token
      );
    }

    // 3. Sync submissions.json
    if (fs.existsSync(SUBMISSIONS_FILE)) {
      const subsContent = await fs.promises.readFile(SUBMISSIONS_FILE, 'utf-8');
      await pushFileToGitHub(
        ghCfg.owner,
        ghCfg.repo,
        ghCfg.branch || 'main',
        'data/submissions.json',
        subsContent,
        `Auto-sync: update submissions (${reason})`,
        ghCfg.token
      );
    }
  } catch (err) {
    console.error('Automatic GitHub sync error:', err.message);
  }
}

// ======================== API ROUTES ========================

import { spawn, exec, execSync } from 'child_process';
import os from 'os';

// Check if a system binary is installed locally
const localBinaryCache = new Map();
function hasCmd(cmd) {
  if (localBinaryCache.has(cmd)) return localBinaryCache.get(cmd);
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    localBinaryCache.set(cmd, true);
    return true;
  } catch (e) {
    localBinaryCache.set(cmd, false);
    return false;
  }
}

// Helper to execute Wandbox online compilation & execution (JDK 22, GCC 13, G++, Python 3, Node.js)
async function executeViaWandbox(compiler, code, stdin = '', timeoutMs = 8000) {
  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs + 4000);
    const res = await fetch('https://wandbox.org/api/compile.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compiler,
        code,
        stdin: String(stdin || '')
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const txt = await res.text();
      return { output: `Compiler API response error: ${txt}`, error: 'Compiler API Error', executionTimeMs: Date.now() - startTime };
    }

    const data = await res.json();
    const executionTimeMs = Date.now() - startTime;

    // 1. Compilation Error
    if (data.compiler_error || (data.status !== '0' && data.status !== 0 && !data.program_output && !data.program_error)) {
      const err = (data.compiler_error || data.compiler_message || 'Compilation Error').trim();
      return {
        output: `Compilation Error:\n${err}`,
        error: 'Compilation Error',
        executionTimeMs
      };
    }

    // 2. Program Output & Runtime Error
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
  } catch (err) {
    return {
      output: `Execution error: ${err.message}`,
      error: err.message,
      executionTimeMs: Date.now() - startTime
    };
  }
}

// Helper to execute child process with timeout and stdin
function runProcess({ cmd, args, cwd, stdin, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let isDone = false;

    const child = spawn(cmd, args, { cwd });

    const timer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        try { child.kill('SIGKILL'); } catch (e) {}
        resolve({
          output: `Error: Execution timed out (${timeoutMs}ms). Check for infinite loops or pending input.`,
          error: 'Time Limit Exceeded',
          exitCode: -1
        });
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (exitCode) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });

    child.on('error', (err) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      resolve({ output: err.message, error: err.message, exitCode: -1, isSpawnError: true });
    });

    if (stdin !== undefined && stdin !== null) {
      try {
        child.stdin.write(String(stdin));
      } catch (e) {}
    }
    try {
      child.stdin.end();
    } catch (e) {}
  });
}

// Code execution endpoint for 4 core languages: Python, Java, C, C++ (and JS)
app.post('/api/run-code', async (req, res) => {
  const { language, code = '', stdin = '', timeoutMs = 6000 } = req.body;
  const lang = (language || 'python').toLowerCase().trim();
  const startTime = Date.now();

  if (lang === 'python' || lang === 'py') {
    if (hasCmd('python3')) {
      try {
        const runRes = await runProcess({
          cmd: 'python3',
          args: ['-u', '-c', code],
          stdin,
          timeoutMs
        });
        const executionTimeMs = Date.now() - startTime;
        if (!runRes.isSpawnError) {
          if (runRes.error && runRes.error === 'Time Limit Exceeded') {
            return res.json({ output: runRes.output, error: runRes.error, executionTimeMs });
          }
          if (runRes.exitCode !== 0 && runRes.stderr) {
            return res.json({
              output: (runRes.stdout ? runRes.stdout + '\n' : '') + runRes.stderr,
              error: runRes.stderr,
              executionTimeMs
            });
          }
          return res.json({
            output: (runRes.stdout || '').replace(/\r\n/g, '\n'),
            error: null,
            executionTimeMs
          });
        }
      } catch (err) {}
    }
    // Fallback to Wandbox Python 3.12
    const wandboxRes = await executeViaWandbox('cpython-3.12.7', code, stdin, timeoutMs);
    return res.json(wandboxRes);
  } else if (lang === 'java') {
    // Sanitize Java code for single-file execution: convert "public class X" to "class X"
    // so any class name works with OpenJDK without public file-name restrictions
    const wandboxJavaCode = code.replace(/\bpublic\s+class\b/g, 'class');

    // Attempt local javac if installed
    if (hasCmd('javac') && hasCmd('java')) {
      let tmpDir = null;
      try {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'java_exec_'));
        let className = 'Main';
        const pubMatch = code.match(/public\s+class\s+([A-Za-z0-9_]+)/);
        if (pubMatch) className = pubMatch[1];
        else {
          const clsMatch = code.match(/class\s+([A-Za-z0-9_]+)/);
          if (clsMatch) className = clsMatch[1];
        }
        const javaFilePath = path.join(tmpDir, `${className}.java`);
        await fs.promises.writeFile(javaFilePath, code, 'utf-8');

        const compileRes = await runProcess({
          cmd: 'javac',
          args: ['-encoding', 'UTF-8', `${className}.java`],
          cwd: tmpDir,
          timeoutMs: 6000
        });

        if (compileRes.exitCode !== 0) {
          const executionTimeMs = Date.now() - startTime;
          const errOut = (compileRes.stderr || compileRes.stdout || 'Java Compilation Error').replace(new RegExp(tmpDir + '/?', 'g'), '');
          return res.json({
            output: `Compilation Error:\n${errOut}`,
            error: 'Compilation Error',
            executionTimeMs
          });
        }

        const runRes = await runProcess({
          cmd: 'java',
          args: ['-Xmx256m', '-Xss32m', '-Dfile.encoding=UTF-8', className],
          cwd: tmpDir,
          stdin,
          timeoutMs
        });

        const executionTimeMs = Date.now() - startTime;
        if (runRes.error && runRes.error === 'Time Limit Exceeded') {
          return res.json({ output: runRes.output, error: runRes.error, executionTimeMs });
        }
        if (runRes.exitCode !== 0 && runRes.stderr) {
          return res.json({
            output: (runRes.stdout ? runRes.stdout + '\n' : '') + runRes.stderr.replace(new RegExp(tmpDir + '/?', 'g'), ''),
            error: runRes.stderr,
            executionTimeMs
          });
        }
        return res.json({
          output: (runRes.stdout || '').replace(/\r\n/g, '\n'),
          error: null,
          executionTimeMs
        });
      } catch (e) {
        // Continue to Wandbox
      } finally {
        if (tmpDir) {
          try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
      }
    }

    // Run on OpenJDK 22 via Wandbox
    const wandboxRes = await executeViaWandbox('openjdk-jdk-22+36', wandboxJavaCode, stdin, timeoutMs);
    return res.json(wandboxRes);
  } else if (lang === 'c') {
    if (hasCmd('gcc')) {
      let tmpDir = null;
      try {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'c_exec_'));
        const cFilePath = path.join(tmpDir, 'prog.c');
        await fs.promises.writeFile(cFilePath, code, 'utf-8');

        const compileRes = await runProcess({
          cmd: 'gcc',
          args: ['-O2', '-pipe', 'prog.c', '-o', 'prog', '-lm'],
          cwd: tmpDir,
          timeoutMs: 5000
        });

        if (compileRes.exitCode !== 0) {
          const executionTimeMs = Date.now() - startTime;
          const errOut = (compileRes.stderr || compileRes.stdout || 'C Compilation Error').replace(new RegExp(tmpDir + '/?', 'g'), '');
          return res.json({
            output: `Compilation Error:\n${errOut}`,
            error: 'Compilation Error',
            executionTimeMs
          });
        }

        const runRes = await runProcess({
          cmd: './prog',
          args: [],
          cwd: tmpDir,
          stdin,
          timeoutMs
        });

        const executionTimeMs = Date.now() - startTime;
        if (runRes.error && runRes.error === 'Time Limit Exceeded') {
          return res.json({ output: runRes.output, error: runRes.error, executionTimeMs });
        }
        if (runRes.exitCode !== 0 && runRes.stderr) {
          return res.json({
            output: (runRes.stdout ? runRes.stdout + '\n' : '') + runRes.stderr,
            error: runRes.stderr,
            executionTimeMs
          });
        }
        return res.json({
          output: (runRes.stdout || '').replace(/\r\n/g, '\n'),
          error: null,
          executionTimeMs
        });
      } catch (e) {
        // Continue to Wandbox
      } finally {
        if (tmpDir) {
          try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
      }
    }

    // Run on GCC 13 via Wandbox
    const wandboxRes = await executeViaWandbox('gcc-13.2.0-c', code, stdin, timeoutMs);
    return res.json(wandboxRes);
  } else if (lang === 'cpp' || lang === 'c++') {
    if (hasCmd('g++')) {
      let tmpDir = null;
      try {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cpp_exec_'));
        const cppFilePath = path.join(tmpDir, 'prog.cpp');
        await fs.promises.writeFile(cppFilePath, code, 'utf-8');

        const compileRes = await runProcess({
          cmd: 'g++',
          args: ['-O2', '-std=c++17', '-pipe', 'prog.cpp', '-o', 'prog', '-lm'],
          cwd: tmpDir,
          timeoutMs: 5000
        });

        if (compileRes.exitCode !== 0) {
          const executionTimeMs = Date.now() - startTime;
          const errOut = (compileRes.stderr || compileRes.stdout || 'C++ Compilation Error').replace(new RegExp(tmpDir + '/?', 'g'), '');
          return res.json({
            output: `Compilation Error:\n${errOut}`,
            error: 'Compilation Error',
            executionTimeMs
          });
        }

        const runRes = await runProcess({
          cmd: './prog',
          args: [],
          cwd: tmpDir,
          stdin,
          timeoutMs
        });

        const executionTimeMs = Date.now() - startTime;
        if (runRes.error && runRes.error === 'Time Limit Exceeded') {
          return res.json({ output: runRes.output, error: runRes.error, executionTimeMs });
        }
        if (runRes.exitCode !== 0 && runRes.stderr) {
          return res.json({
            output: (runRes.stdout ? runRes.stdout + '\n' : '') + runRes.stderr,
            error: runRes.stderr,
            executionTimeMs
          });
        }
        return res.json({
          output: (runRes.stdout || '').replace(/\r\n/g, '\n'),
          error: null,
          executionTimeMs
        });
      } catch (e) {
        // Continue to Wandbox
      } finally {
        if (tmpDir) {
          try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
        }
      }
    }

    // Run on GCC 13 C++ via Wandbox
    const wandboxRes = await executeViaWandbox('gcc-13.2.0', code, stdin, timeoutMs);
    return res.json(wandboxRes);
  } else if (lang === 'javascript' || lang === 'js') {
    try {
      const wrappedJs = `
        const fs = require('fs');
        const stdin = fs.readFileSync(0, 'utf-8');
        const lines = stdin.split(/\\r?\\n/);
        let lineIdx = 0;
        function readline() { return lineIdx < lines.length ? lines[lineIdx++] : ''; }
        const input = readline;
        
        ${code}
      `;
      const runRes = await runProcess({
        cmd: 'node',
        args: ['-e', wrappedJs],
        stdin,
        timeoutMs
      });
      const executionTimeMs = Date.now() - startTime;
      if (runRes.error) {
        return res.json({ output: runRes.output || runRes.error, error: runRes.error, executionTimeMs });
      }
      if (runRes.exitCode !== 0 && runRes.stderr) {
        return res.json({ output: (runRes.stdout ? runRes.stdout + '\n' : '') + runRes.stderr, error: runRes.stderr, executionTimeMs });
      }
      return res.json({ output: (runRes.stdout || '').replace(/\r\n/g, '\n'), error: null, executionTimeMs });
    } catch (err) {
      return res.status(500).json({ error: err.message, output: err.message });
    }
  } else {
    res.status(400).json({ error: `Language "${lang}" not supported. Supported: python, java, c, cpp` });
  }
});

// 1. Get Questions / Specific or Active Test
app.get('/api/questions', async (req, res) => {
  try {
    const { testId } = req.query;
    if (testId) {
      const specificPath = path.join(TESTS_DIR, `${testId}.json`);
      if (fs.existsSync(specificPath)) {
        const data = await fs.promises.readFile(specificPath, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        return res.send(data);
      }
      const store = await getTestsStore();
      if (store.tests && store.tests[testId]) {
        res.setHeader('Content-Type', 'application/json');
        return res.json(store.tests[testId]);
      }
    }
    const data = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    console.error('Failed to read questions:', err);
    res.status(500).json({ error: 'Failed to read questions' });
  }
});

// 1b. List Available Tests with metadata and active state
app.get('/api/tests', async (req, res) => {
  try {
    const isStudent = req.query.role === 'student' || req.query.activeOnly === 'true';
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    if (!Array.isArray(store.activeTestIds)) {
      store.activeTestIds = store.activeTestId ? [store.activeTestId] : ['default'];
    }

    const files = await fs.promises.readdir(TESTS_DIR);
    let tests = [];
    
    // Merge from filesystem & store
    const seenIds = new Set();

    for (const f of files) {
      if (f.endsWith('.json')) {
        const id = f.replace('.json', '');
        seenIds.add(id);
        try {
          const content = await fs.promises.readFile(path.join(TESTS_DIR, f), 'utf-8');
          const parsed = JSON.parse(content);
          
          // Also sync to store if missing
          if (!store.tests[id]) {
            store.tests[id] = parsed;
          }

          // Active flag: check explicit parsed.isActive, or if it is present in store.activeTestIds
          let isAct;
          if (parsed.isActive !== undefined) {
            isAct = !!parsed.isActive;
          } else if (store.activeTestIds.includes(id) || id === store.activeTestId || id === 'default') {
            isAct = true;
          } else {
            isAct = false;
          }
          parsed.isActive = isAct;

          const mcqTotalMarks = (parsed.mcq || []).reduce((acc, q) => acc + (q.marks || 1), 0);
          const progTotalMarks = (parsed.programs || []).reduce((acc, p) => acc + (p.marks || 5), 0);
          const totalMarks = mcqTotalMarks + progTotalMarks;

          tests.push({
            id,
            title: parsed.examTitle || id,
            durationMinutes: parsed.durationMinutes || 60,
            studentPassword: parsed.studentPassword || 'test-2026',
            mcqCount: (parsed.mcq || []).length,
            programCount: (parsed.programs || []).length,
            totalMarks,
            updatedAt: parsed.updatedAt || parsed.createdAt || null,
            isActive: isAct
          });
        } catch (e) {}
      }
    }

    // Also include any tests in store that might not be on disk yet
    for (const [id, parsed] of Object.entries(store.tests)) {
      if (!seenIds.has(id) && parsed) {
        try {
          let isAct;
          if (parsed.isActive !== undefined) {
            isAct = !!parsed.isActive;
          } else if (store.activeTestIds.includes(id) || id === store.activeTestId || id === 'default') {
            isAct = true;
          } else {
            isAct = false;
          }
          parsed.isActive = isAct;

          await fs.promises.writeFile(path.join(TESTS_DIR, `${id}.json`), JSON.stringify(parsed, null, 2), 'utf-8');
          const mcqTotalMarks = (parsed.mcq || []).reduce((acc, q) => acc + (q.marks || 1), 0);
          const progTotalMarks = (parsed.programs || []).reduce((acc, p) => acc + (p.marks || 5), 0);
          const totalMarks = mcqTotalMarks + progTotalMarks;

          tests.push({
            id,
            title: parsed.examTitle || id,
            durationMinutes: parsed.durationMinutes || 60,
            studentPassword: parsed.studentPassword || 'test-2026',
            mcqCount: (parsed.mcq || []).length,
            programCount: (parsed.programs || []).length,
            totalMarks,
            updatedAt: parsed.updatedAt || parsed.createdAt || null,
            isActive: isAct
          });
        } catch (e) {}
      }
    }

    // Synchronize store.activeTestIds
    store.activeTestIds = tests.filter(t => t.isActive).map(t => t.id);
    if (!store.activeTestId || !store.activeTestIds.includes(store.activeTestId)) {
      store.activeTestId = store.activeTestIds[0] || (tests[0] ? tests[0].id : 'default');
    }
    await saveTestsStore(store);

    const totalCount = tests.length;
    const activeCount = tests.filter(t => t.isActive).length;

    // IF STUDENT: return ONLY active tests!
    if (isStudent) {
      tests = tests.filter(t => t.isActive);
    } else {
      // Sort active tests first, then by title
      tests.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return a.title.localeCompare(b.title);
      });
    }

    res.json({
      tests,
      totalCount,
      activeCount,
      activeTestId: store.activeTestId,
      activeTestIds: store.activeTestIds
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list tests: ' + err.message });
  }
});

// 1c. Toggle a test's Active / Live status (Admin control)
app.post('/api/tests/toggle-active', async (req, res) => {
  try {
    const { id, isActive } = req.body;
    if (!id) return res.status(400).json({ error: 'Test ID required' });
    const shouldBeActive = isActive === true || isActive === 'true';

    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    if (!Array.isArray(store.activeTestIds)) store.activeTestIds = [];

    const targetFile = path.join(TESTS_DIR, `${id}.json`);
    let testObj = store.tests[id];
    if (fs.existsSync(targetFile)) {
      const content = await fs.promises.readFile(targetFile, 'utf-8');
      testObj = JSON.parse(content);
    }

    if (!testObj) {
      return res.status(404).json({ error: 'Test not found' });
    }

    testObj.isActive = shouldBeActive;
    testObj.updatedAt = new Date().toISOString();

    // Persist to disk
    await fs.promises.writeFile(targetFile, JSON.stringify(testObj, null, 2), 'utf-8');
    store.tests[id] = testObj;

    if (shouldBeActive) {
      if (!store.activeTestIds.includes(id)) {
        store.activeTestIds.push(id);
      }
      store.activeTestId = id;
      // Also update questions.json
      await fs.promises.writeFile(QUESTIONS_FILE, JSON.stringify(testObj, null, 2), 'utf-8');
    } else {
      store.activeTestIds = store.activeTestIds.filter(tId => tId !== id);
      if (store.activeTestId === id) {
        store.activeTestId = store.activeTestIds[0] || null;
      }
    }

    await saveTestsStore(store);

    // Auto-sync in background
    autoSyncToGitHub(`Toggled test "${testObj.examTitle || id}" to ${shouldBeActive ? 'ACTIVE' : 'INACTIVE'}`).catch(() => {});

    res.json({
      success: true,
      id,
      isActive: shouldBeActive,
      title: testObj.examTitle || id,
      activeTestIds: store.activeTestIds,
      message: `Exam "${testObj.examTitle || id}" is now ${shouldBeActive ? 'LIVE for students' : 'INACTIVE (hidden from students)'}.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle test status: ' + err.message });
  }
});

// 1d. Load a specific test by ID into active questions
app.post('/api/tests/switch', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Test ID required' });
    const targetFile = path.join(TESTS_DIR, `${id}.json`);
    let testContent;
    let testObj;
    if (fs.existsSync(targetFile)) {
      testContent = await fs.promises.readFile(targetFile, 'utf-8');
      testObj = JSON.parse(testContent);
    } else {
      const store = await getTestsStore();
      if (store.tests && store.tests[id]) {
        testObj = store.tests[id];
        testContent = JSON.stringify(testObj, null, 2);
        await fs.promises.writeFile(targetFile, testContent, 'utf-8');
      } else {
        return res.status(404).json({ error: 'Test not found' });
      }
    }

    // Set this test as active
    testObj.isActive = true;
    const updatedStr = JSON.stringify(testObj, null, 2);
    await fs.promises.writeFile(targetFile, updatedStr, 'utf-8');
    await fs.promises.writeFile(QUESTIONS_FILE, updatedStr, 'utf-8');
    
    // Update active test ID in store
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[id] = testObj;
    if (!Array.isArray(store.activeTestIds)) store.activeTestIds = [];
    if (!store.activeTestIds.includes(id)) store.activeTestIds.push(id);
    store.activeTestId = id;
    await saveTestsStore(store);

    // Auto-sync in background
    autoSyncToGitHub(`Activated and switched test to ${id}`).catch(() => {});

    res.json({ success: true, message: `Activated and loaded "${testObj.examTitle || id}"`, data: testObj });
  } catch (err) {
    res.status(500).json({ error: 'Failed to switch test: ' + err.message });
  }
});

// 1e. Create a brand new test
app.post('/api/tests/create', async (req, res) => {
  try {
    const { title, durationMinutes, password, template, isActive } = req.body;
    const testTitle = (title || 'New Test').trim();
    const testId = 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const markActive = isActive !== false;

    let newTestData;
    if (template === 'empty') {
      newTestData = {
        examTitle: testTitle,
        durationMinutes: parseInt(durationMinutes, 10) || 60,
        studentPassword: password || 'test-2026',
        isActive: markActive,
        mcq: [],
        programs: [],
        createdAt: new Date().toISOString()
      };
    } else {
      // Starter template with sample MCQ and coding problem
      newTestData = {
        examTitle: testTitle,
        durationMinutes: parseInt(durationMinutes, 10) || 60,
        studentPassword: password || 'test-2026',
        isActive: markActive,
        mcq: [
          {
            id: 'm_' + Date.now(),
            question: 'Which data structure follows the Last In First Out (LIFO) principle?',
            options: ['Queue', 'Stack', 'Array', 'Linked List'],
            answer: 1,
            marks: 1
          }
        ],
        programs: [
          {
            id: 'p_' + Date.now(),
            title: 'Sum of Two Numbers',
            statement: 'Read two space-separated integers a and b from standard input and print their sum to standard output.',
            marks: 5,
            testCases: [
              { input: '2 3', expectedOutput: '5', isSample: true },
              { input: '10 -4', expectedOutput: '6', isSample: true },
              { input: '100 250', expectedOutput: '350', isSample: false }
            ]
          }
        ],
        createdAt: new Date().toISOString()
      };
    }

    const testFile = path.join(TESTS_DIR, `${testId}.json`);
    const jsonStr = JSON.stringify(newTestData, null, 2);
    await fs.promises.writeFile(testFile, jsonStr, 'utf-8');

    // Also activate it immediately
    await fs.promises.writeFile(QUESTIONS_FILE, jsonStr, 'utf-8');

    // Persist to store
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[testId] = newTestData;
    store.activeTestId = testId;
    await saveTestsStore(store);

    // Auto-sync in background
    autoSyncToGitHub(`Created test "${testTitle}"`).catch(() => {});

    res.json({ success: true, testId, testData: newTestData, message: `Created and activated "${testTitle}"` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create test: ' + err.message });
  }
});

// 1e. Duplicate an existing test
app.post('/api/tests/duplicate', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Source Test ID required' });
    const sourcePath = path.join(TESTS_DIR, `${id}.json`);
    let parsed;
    if (fs.existsSync(sourcePath)) {
      const content = await fs.promises.readFile(sourcePath, 'utf-8');
      parsed = JSON.parse(content);
    } else {
      const store = await getTestsStore();
      if (store.tests && store.tests[id]) {
        parsed = JSON.parse(JSON.stringify(store.tests[id]));
      } else {
        return res.status(404).json({ error: 'Source test not found' });
      }
    }

    parsed.examTitle = `${parsed.examTitle || 'Test'} (Copy)`;
    parsed.createdAt = new Date().toISOString();
    parsed.updatedAt = new Date().toISOString();

    const newId = 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const newPath = path.join(TESTS_DIR, `${newId}.json`);
    await fs.promises.writeFile(newPath, JSON.stringify(parsed, null, 2), 'utf-8');

    // Persist to store
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[newId] = parsed;
    await saveTestsStore(store);

    // Auto-sync in background
    autoSyncToGitHub(`Duplicated test "${parsed.examTitle}"`).catch(() => {});

    res.json({ success: true, newId, title: parsed.examTitle, message: `Duplicated as "${parsed.examTitle}"` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to duplicate test: ' + err.message });
  }
});

// 1f. Delete a test (with safe active-test fallback)
app.delete('/api/tests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const testFile = path.join(TESTS_DIR, `${id}.json`);
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};

    const existsOnDisk = fs.existsSync(testFile);
    const existsInStore = !!store.tests[id];

    if (!existsOnDisk && !existsInStore) {
      return res.status(404).json({ error: 'Test not found' });
    }

    if (existsOnDisk) {
      await fs.promises.unlink(testFile);
    }
    delete store.tests[id];

    // Remove from activeTestIds
    if (Array.isArray(store.activeTestIds)) {
      store.activeTestIds = store.activeTestIds.filter(tId => tId !== id);
    }

    // Find remaining tests
    const remainingIds = Object.keys(store.tests);
    let newActiveId = null;
    let newActiveTitle = null;

    // Check if the deleted test was active
    if (store.activeTestId === id || remainingIds.length > 0) {
      newActiveId = store.activeTestIds[0] || remainingIds[0] || 'default';
      store.activeTestId = newActiveId;
      
      // Load the new active test into questions.json
      const nextTestObj = store.tests[newActiveId];
      if (nextTestObj) {
        newActiveTitle = nextTestObj.examTitle || 'Class Test';
        const nextContent = JSON.stringify(nextTestObj, null, 2);
        await fs.promises.writeFile(QUESTIONS_FILE, nextContent, 'utf-8');
        const nextFilePath = path.join(TESTS_DIR, `${newActiveId}.json`);
        if (!fs.existsSync(nextFilePath)) {
          await fs.promises.writeFile(nextFilePath, nextContent, 'utf-8');
        }
      }
    }

    await saveTestsStore(store);

    // Auto-sync in background
    autoSyncToGitHub(`Deleted test ${id}`).catch(() => {});

    res.json({
      success: true,
      message: `Deleted test ${id}`,
      newActiveId,
      newActiveTitle,
      remainingCount: remainingIds.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete test: ' + err.message });
  }
});

// 1g. Bulk restore or import tests from client / backup
app.post('/api/tests/restore', async (req, res) => {
  try {
    const { tests } = req.body;
    if (!tests) return res.status(400).json({ error: 'No tests provided' });

    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    let restoredCount = 0;

    const testEntries = Array.isArray(tests) 
      ? tests.map((t, idx) => ({ id: t.id || `restored_${Date.now()}_${idx}`, data: t.data || t }))
      : Object.entries(tests).map(([id, data]) => ({ id, data }));

    for (const { id, data } of testEntries) {
      if (data && (data.examTitle || data.mcq || data.programs)) {
        const cleanData = {
          examTitle: data.examTitle || 'Restored Test',
          durationMinutes: parseInt(data.durationMinutes, 10) || 60,
          studentPassword: data.studentPassword || 'test-2026',
          mcq: Array.isArray(data.mcq) ? data.mcq : [],
          programs: Array.isArray(data.programs) ? data.programs : [],
          updatedAt: data.updatedAt || new Date().toISOString()
        };
        store.tests[id] = cleanData;
        const testFilePath = path.join(TESTS_DIR, `${id}.json`);
        await fs.promises.writeFile(testFilePath, JSON.stringify(cleanData, null, 2), 'utf-8');
        restoredCount++;
      }
    }

    await saveTestsStore(store);
    autoSyncToGitHub(`Restored ${restoredCount} tests`).catch(() => {});
    res.json({ success: true, restoredCount, message: `Restored ${restoredCount} test(s)` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restore tests: ' + err.message });
  }
});

// 1h. Export all tests in a single JSON bundle
app.get('/api/tests/export-bundle', async (req, res) => {
  try {
    const store = await getTestsStore();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="all-tests-backup-${new Date().toISOString().slice(0,10)}.json"`);
    res.send(JSON.stringify(store, null, 2));
  } catch (err) {
    res.status(500).json({ error: 'Failed to export tests bundle: ' + err.message });
  }
});

// 2. Save Questions (Admin)
app.post('/api/save-questions', async (req, res) => {
  try {
    const questionsData = req.body;
    if (!questionsData || !Array.isArray(questionsData.mcq) || !Array.isArray(questionsData.programs)) {
      return res.status(400).json({ error: 'Invalid questions payload' });
    }
    questionsData.updatedAt = new Date().toISOString();
    const jsonStr = JSON.stringify(questionsData, null, 2);
    await fs.promises.writeFile(QUESTIONS_FILE, jsonStr, 'utf-8');

    // Also update in tests directory
    const testId = req.body.testId || 'default';
    const testFilePath = path.join(TESTS_DIR, `${testId}.json`);
    await fs.promises.writeFile(testFilePath, jsonStr, 'utf-8');

    // Also persist to store
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[testId] = questionsData;
    store.activeTestId = testId;
    await saveTestsStore(store);

    // Auto-sync to GitHub in background
    autoSyncToGitHub(`Updated questions for ${questionsData.examTitle || testId}`).catch(() => {});

    res.json({
      success: true,
      message: 'Questions updated and saved successfully'
    });
  } catch (err) {
    console.error('Error saving questions.json:', err);
    res.status(500).json({ error: 'Failed to write questions file' });
  }
});

// 3. Save Student Submission (Live autosave or Final submit)
app.post('/api/submit', async (req, res) => {
  try {
    const { roll, name, status, mcqAnswers, programAnswers, mcqScore, mcqMax, codeScore, codeMax, totalScore, maxScore, codeResults, testId, testTitle, questionsSnapshot } = req.body;

    if (!roll) {
      return res.status(400).json({ error: 'Student roll number is required' });
    }

    const rollKey = String(roll).trim();
    const subs = await getSubmissions();

    const existing = subs[rollKey] || {};
    const updated = {
      ...existing,
      roll: rollKey,
      name: name || existing.name || '',
      status: status || existing.status || 'submitted',
      testId: testId || existing.testId || 'default',
      testTitle: testTitle || existing.testTitle || 'Class Test',
      questionsSnapshot: questionsSnapshot !== undefined ? questionsSnapshot : (existing.questionsSnapshot || null),
      mcqAnswers: mcqAnswers !== undefined ? mcqAnswers : (existing.mcqAnswers || {}),
      programAnswers: programAnswers !== undefined ? programAnswers : (existing.programAnswers || {}),
      mcqScore: mcqScore !== undefined ? mcqScore : (existing.mcqScore ?? null),
      mcqMax: mcqMax !== undefined ? mcqMax : (existing.mcqMax ?? null),
      codeScore: codeScore !== undefined ? codeScore : (existing.codeScore ?? null),
      codeMax: codeMax !== undefined ? codeMax : (existing.codeMax ?? null),
      totalScore: totalScore !== undefined ? totalScore : (existing.totalScore ?? null),
      maxScore: maxScore !== undefined ? maxScore : (existing.maxScore ?? null),
      codeResults: codeResults !== undefined ? codeResults : (existing.codeResults || {}),
      updatedAt: new Date().toISOString(),
      submittedAt: status === 'submitted' ? (existing.submittedAt || new Date().toISOString()) : (existing.submittedAt || null)
    };

    subs[rollKey] = updated;
    await saveSubmissions(subs);

    // Save individual student json
    const studentFilePath = path.join(STUDENTS_DIR, `${rollKey}.json`);
    await fs.promises.writeFile(studentFilePath, JSON.stringify(updated, null, 2), 'utf-8');

    // If submitted and GitHub configured, push to GitHub
    let ghResult = null;
    if (status === 'submitted') {
      const ghCfg = await getGithubConfig();
      if (ghCfg.token && ghCfg.owner && ghCfg.repo) {
        ghResult = await pushFileToGitHub(
          ghCfg.owner,
          ghCfg.repo,
          ghCfg.branch || 'main',
          `submissions/${rollKey}.json`,
          JSON.stringify(updated, null, 2),
          `Student Submission: ${updated.name || 'Student'} (${rollKey}) - Score: ${updated.totalScore}`,
          ghCfg.token
        );
      }
    }

    res.json({
      success: true,
      data: updated,
      githubSynced: ghResult?.success || false
    });
  } catch (err) {
    console.error('Error handling submission:', err);
    res.status(500).json({ error: 'Failed to record student submission' });
  }
});

// 4. Get all student submissions (Admin)
app.get('/api/submissions', async (req, res) => {
  try {
    const subs = await getSubmissions();
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve submissions' });
  }
});

// 5. Get individual student submission (Student or Admin)
app.get('/api/submissions/:roll', async (req, res) => {
  try {
    const roll = String(req.params.roll).trim();
    const subs = await getSubmissions();
    const studentSub = subs[roll];
    if (!studentSub) {
      return res.status(404).json({ error: 'No submission found for this roll number' });
    }
    res.json(studentSub);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve student submission' });
  }
});

// 6. GitHub Config Endpoints
app.get('/api/github-config', async (req, res) => {
  try {
    const cfg = await getGithubConfig();
    // Mask token for security
    const masked = {
      ...cfg,
      hasToken: !!cfg.token,
      tokenMasked: cfg.token ? `${cfg.token.slice(0, 4)}...${cfg.token.slice(-4)}` : ''
    };
    delete masked.token;
    res.json(masked);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read GitHub config' });
  }
});

app.post('/api/github-config', async (req, res) => {
  try {
    const { owner, repo, branch, token } = req.body;
    const current = await getGithubConfig();
    const updated = {
      owner: owner || current.owner || 'jegadeeshfairness28',
      repo: repo || current.repo || 'test-portal',
      branch: branch || current.branch || 'main',
      token: token !== undefined ? token : (current.token || '')
    };
    await saveGithubConfig(updated);
    res.json({ success: true, message: 'GitHub configuration updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save GitHub config' });
  }
});

// 7. Sync All Submissions to GitHub (Bulk export commit)
app.post('/api/github-sync-all', async (req, res) => {
  try {
    const ghCfg = await getGithubConfig();
    if (!ghCfg.token || !ghCfg.owner || !ghCfg.repo) {
      return res.status(400).json({
        success: false,
        error: 'Please configure your GitHub Personal Access Token (PAT), Owner, and Repo in Admin settings.'
      });
    }

    const subs = await getSubmissions();
    const subsCount = Object.keys(subs).length;

    // 1. Push combined submissions.json
    const pushSubmissions = await pushFileToGitHub(
      ghCfg.owner,
      ghCfg.repo,
      ghCfg.branch || 'main',
      'data/submissions.json',
      JSON.stringify(subs, null, 2),
      `Sync all ${subsCount} student submissions to GitHub [${new Date().toISOString()}]`,
      ghCfg.token
    );

    // 2. Push questions.json
    const questionsData = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
    const pushQuestions = await pushFileToGitHub(
      ghCfg.owner,
      ghCfg.repo,
      ghCfg.branch || 'main',
      'questions.json',
      questionsData,
      `Sync questions.json to GitHub [${new Date().toISOString()}]`,
      ghCfg.token
    );

    // 3. Push CSV report
    const headers = ['Roll Number', 'Student Name', 'MCQ Score', 'Coding Score', 'Total Score', 'Status', 'Submitted At'];
    const csvRows = [headers.join(',')];
    Object.values(subs).forEach(r => {
      csvRows.push([
        `"${r.roll || ''}"`,
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${r.mcqScore ?? '-'}"`,
        `"${r.codeScore ?? '-'}"`,
        `"${r.totalScore ?? '-'}"`,
        `"${r.status || 'in-progress'}"`,
        `"${r.submittedAt || '-'}"`
      ].join(','));
    });
    await pushFileToGitHub(
      ghCfg.owner,
      ghCfg.repo,
      ghCfg.branch || 'main',
      'reports/test-results.csv',
      csvRows.join('\n'),
      `Sync test results CSV report to GitHub [${new Date().toISOString()}]`,
      ghCfg.token
    );

    res.json({
      success: true,
      message: `Successfully synchronized questions and ${subsCount} student submissions to GitHub repository (${ghCfg.owner}/${ghCfg.repo})!`,
      details: { pushSubmissions, pushQuestions }
    });
  } catch (err) {
    console.error('GitHub bulk sync error:', err);
    res.status(500).json({ error: 'Failed to synchronize with GitHub: ' + err.message });
  }
});

// Serve static files from root directory
app.use(express.static(__dirname));

// Route for admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Class Test Portal server running on http://0.0.0.0:${PORT}`);
});

export default app;
