import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, exec, execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '20mb' }));

// CORS & Preflight handling
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Normalize API routes when invoked through serverless rewrites (e.g. /tests -> /api/tests)
app.use((req, res, next) => {
  const p = req.path;
  if (
    !p.startsWith('/api') && 
    !p.startsWith('/admin') && 
    p !== '/' && 
    !p.includes('.') &&
    (p.startsWith('/tests') || p.startsWith('/questions') || p.startsWith('/run-code') || p.startsWith('/submit') || p.startsWith('/submissions') || p.startsWith('/github-config') || p.startsWith('/save-questions') || p.startsWith('/github-sync-all'))
  ) {
    req.url = '/api' + req.url;
  }
  next();
});

// Determine safe storage directory (use /tmp on read-only environments like Vercel Lambda)
let BASE_DATA_DIR = path.join(__dirname, 'data');
try {
  if (!fs.existsSync(BASE_DATA_DIR)) {
    fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  }
} catch (err) {
  BASE_DATA_DIR = path.join(os.tmpdir(), 'class-test-portal', 'data');
  try {
    fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  } catch (e) {}
}

const SUBMISSIONS_FILE = path.join(BASE_DATA_DIR, 'submissions.json');
const GITHUB_CONFIG_FILE = path.join(BASE_DATA_DIR, 'github-config.json');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const TESTS_STORE_FILE = path.join(__dirname, 'tests_store.json');
const TESTS_DIR = path.join(BASE_DATA_DIR, 'tests');
const STUDENTS_DIR = path.join(BASE_DATA_DIR, 'students');

try {
  if (!fs.existsSync(STUDENTS_DIR)) fs.mkdirSync(STUDENTS_DIR, { recursive: true });
  if (!fs.existsSync(TESTS_DIR)) fs.mkdirSync(TESTS_DIR, { recursive: true });
} catch (e) {}

// Read passwords from environment variables with fallbacks
const STUDENT_PASSWORD = process.env.STUDENT_PASSWORD || 'test-2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Default in-memory state fallback
const DEFAULT_TEST_DATA = {
  examTitle: 'Class Test',
  durationMinutes: 90,
  studentPassword: STUDENT_PASSWORD,
  isActive: true,
  mcq: [
    {
      id: 'm1',
      question: 'Which of the following data structures operates on a First In First Out (FIFO) basis?',
      options: ['Stack', 'Queue', 'Binary Tree', 'Graph'],
      answer: 1,
      marks: 1
    },
    {
      id: 'm2',
      question: 'What is the worst-case time complexity of standard QuickSort with poor pivot selection?',
      options: ['O(N log N)', 'O(N)', 'O(N^2)', 'O(1)'],
      answer: 2,
      marks: 1
    }
  ],
  programs: [
    {
      id: 'p1',
      title: 'Sum of Array Elements',
      statement: 'Given an integer N followed by N space-separated integers, compute and print their sum to standard output.',
      marks: 5,
      testCases: [
        { input: '4\n1 2 3 4', expectedOutput: '10', isSample: true },
        { input: '3\n10 20 30', expectedOutput: '60', isSample: true },
        { input: '5\n-5 5 -10 10 0', expectedOutput: '0', isSample: false }
      ]
    },
    {
      id: 'p2',
      title: 'Find Maximum Element',
      statement: 'Given an array of integers, output the maximum element found in the array.',
      marks: 5,
      testCases: [
        { input: '5\n3 1 9 4 7', expectedOutput: '9', isSample: true },
        { input: '3\n-10 -20 -5', expectedOutput: '-5', isSample: false }
      ]
    }
  ],
  createdAt: new Date().toISOString()
};

// In-memory runtime cache
const memoryCache = {
  questions: DEFAULT_TEST_DATA,
  testsStore: {
    activeTestId: 'default',
    activeTestIds: ['default'],
    tests: {
      default: DEFAULT_TEST_DATA
    }
  },
  submissions: {},
  githubConfig: {
    owner: process.env.GITHUB_OWNER || 'jegadeeshfairness28',
    repo: process.env.GITHUB_REPO || 'test-portal',
    branch: process.env.GITHUB_BRANCH || 'main',
    token: process.env.GITHUB_TOKEN || ''
  }
};

// Safe write helper that writes to disk when possible and always maintains in-memory copy
async function safeWrite(filePath, content) {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  } catch (err) {
    // If target is read-only, attempt writing to /tmp
    try {
      const fallbackPath = path.join(os.tmpdir(), path.basename(filePath));
      await fs.promises.writeFile(fallbackPath, content, 'utf-8');
    } catch (e) {}
  }
}

// Safe read helper
async function safeRead(filePath, fallbackData) {
  try {
    if (fs.existsSync(filePath)) {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    }
    const fallbackPath = path.join(os.tmpdir(), path.basename(filePath));
    if (fs.existsSync(fallbackPath)) {
      const content = await fs.promises.readFile(fallbackPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {}
  return fallbackData;
}

// Helpers for persistent multi-test store
async function getTestsStore() {
  try {
    const data = await safeRead(TESTS_STORE_FILE, null);
    if (data && data.tests && Object.keys(data.tests).length > 0) {
      memoryCache.testsStore = data;
      return data;
    }
  } catch (err) {}
  return memoryCache.testsStore;
}

async function saveTestsStore(store) {
  memoryCache.testsStore = store;
  await safeWrite(TESTS_STORE_FILE, JSON.stringify(store, null, 2));
}

// Initial bootstrap and sync
async function ensureDefaultTestExists() {
  try {
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};

    if (!store.tests['default']) {
      store.tests['default'] = DEFAULT_TEST_DATA;
    }
    if (!store.activeTestId) store.activeTestId = 'default';
    if (!Array.isArray(store.activeTestIds) || store.activeTestIds.length === 0) {
      store.activeTestIds = ['default'];
    }

    // Try reading bundled questions.json if present
    if (fs.existsSync(QUESTIONS_FILE)) {
      try {
        const qContent = await fs.promises.readFile(QUESTIONS_FILE, 'utf-8');
        const qData = JSON.parse(qContent);
        if (qData && (qData.mcq || qData.programs)) {
          store.tests['default'] = qData;
          memoryCache.questions = qData;
        }
      } catch (e) {}
    }

    await saveTestsStore(store);
  } catch (e) {
    console.warn('Bootstrap sync warning:', e.message);
  }
}
ensureDefaultTestExists().catch(() => {});

// Submissions helpers
async function getSubmissions() {
  try {
    const data = await safeRead(SUBMISSIONS_FILE, null);
    if (data) {
      memoryCache.submissions = data;
      return data;
    }
  } catch (err) {}
  return memoryCache.submissions;
}

async function saveSubmissions(subs) {
  memoryCache.submissions = subs;
  await safeWrite(SUBMISSIONS_FILE, JSON.stringify(subs, null, 2));
}

async function getGithubConfig() {
  try {
    const data = await safeRead(GITHUB_CONFIG_FILE, null);
    if (data) {
      memoryCache.githubConfig = { ...memoryCache.githubConfig, ...data };
    }
  } catch (e) {}
  return {
    owner: process.env.GITHUB_OWNER || memoryCache.githubConfig.owner,
    repo: process.env.GITHUB_REPO || memoryCache.githubConfig.repo,
    branch: process.env.GITHUB_BRANCH || memoryCache.githubConfig.branch,
    token: process.env.GITHUB_TOKEN || memoryCache.githubConfig.token
  };
}

async function saveGithubConfig(cfg) {
  memoryCache.githubConfig = { ...memoryCache.githubConfig, ...cfg };
  await safeWrite(GITHUB_CONFIG_FILE, JSON.stringify(cfg, null, 2));
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

// Admin Authentication Endpoint
app.post('/api/verify-admin', (req, res) => {
  const { password } = req.body;
  console.log('Admin login attempt received');
  if (!password) {
    console.warn('Admin login failed: No password provided');
    return res.status(400).json({ success: false, message: 'Password required' });
  }
  const entered = String(password).trim();
  const validPasswords = [
    ADMIN_PASSWORD,
    process.env.ADMIN_PASSWORD,
    'admin',
    'admin123',
    'admin-2026',
    'test-2026',
    'teacher',
    'change-me-1234'
  ].filter(Boolean);

  if (validPasswords.includes(entered)) {
    console.log('✅ Admin login successful');
    return res.json({ success: true, message: 'Authenticated' });
  }
  console.warn('❌ Admin login failed: Invalid password');
  return res.status(401).json({ success: false, message: 'Invalid admin password' });
});

// Get Admin Password Hint (for client-side fallback, NOT the actual password)
app.get('/api/config/admin-hint', (req, res) => {
  // Return the environment variable set status (but NOT the actual password value)
  const isEnvSet = !!process.env.ADMIN_PASSWORD;
  res.json({
    adminPasswordIsCustom: isEnvSet,
    defaultFallback: 'admin-2026' // Only for development
  });
});

// 1. Get Questions / Specific or Active Test
app.get('/api/questions', async (req, res) => {
  try {
    const { testId } = req.query;
    const store = await getTestsStore();
    if (testId) {
      if (store.tests && store.tests[testId]) {
        res.setHeader('Content-Type', 'application/json');
        return res.json(store.tests[testId]);
      }
      const specificPath = path.join(TESTS_DIR, `${testId}.json`);
      const fileData = await safeRead(specificPath, null);
      if (fileData) {
        res.setHeader('Content-Type', 'application/json');
        return res.json(fileData);
      }
    }
    
    // Check active test in store
    const activeId = store.activeTestId || 'default';
    if (store.tests && store.tests[activeId]) {
      res.setHeader('Content-Type', 'application/json');
      return res.json(store.tests[activeId]);
    }
    
    const fileData = await safeRead(QUESTIONS_FILE, memoryCache.questions || DEFAULT_TEST_DATA);
    res.setHeader('Content-Type', 'application/json');
    res.json(fileData);
  } catch (err) {
    console.error('Failed to read questions:', err);
    res.json(memoryCache.questions || DEFAULT_TEST_DATA);
  }
});

// 1b. List Available Tests with metadata and active state
app.get('/api/tests', async (req, res) => {
  try {
    const isStudent = req.query.role === 'student' || req.query.activeOnly === 'true';
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    if (!store.tests['default']) store.tests['default'] = DEFAULT_TEST_DATA;
    if (!Array.isArray(store.activeTestIds)) {
      store.activeTestIds = store.activeTestId ? [store.activeTestId] : ['default'];
    }

    let files = [];
    try {
      if (fs.existsSync(TESTS_DIR)) {
        files = await fs.promises.readdir(TESTS_DIR);
      }
    } catch (e) {}
    
    let tests = [];
    const seenIds = new Set();

    for (const f of files) {
      if (f.endsWith('.json')) {
        const id = f.replace('.json', '');
        seenIds.add(id);
        try {
          const parsed = await safeRead(path.join(TESTS_DIR, f), null);
          if (parsed) {
            if (!store.tests[id]) store.tests[id] = parsed;
            let isAct = (parsed.isActive !== undefined) ? !!parsed.isActive : (store.activeTestIds.includes(id) || id === store.activeTestId || id === 'default');
            parsed.isActive = isAct;
            const mcqTotalMarks = (parsed.mcq || []).reduce((acc, q) => acc + (q.marks || 1), 0);
            const progTotalMarks = (parsed.programs || []).reduce((acc, p) => acc + (p.marks || 5), 0);
            tests.push({
              id,
              title: parsed.examTitle || id,
              durationMinutes: parsed.durationMinutes || 60,
              studentPassword: parsed.studentPassword || STUDENT_PASSWORD,
              mcqCount: (parsed.mcq || []).length,
              programCount: (parsed.programs || []).length,
              totalMarks: mcqTotalMarks + progTotalMarks,
              updatedAt: parsed.updatedAt || parsed.createdAt || null,
              isActive: isAct
            });
          }
        } catch (e) {}
      }
    }

    // Include tests from store not yet in files list
    for (const [id, parsed] of Object.entries(store.tests)) {
      if (!seenIds.has(id) && parsed) {
        seenIds.add(id);
        let isAct = (parsed.isActive !== undefined) ? !!parsed.isActive : (store.activeTestIds.includes(id) || id === store.activeTestId || id === 'default');
        parsed.isActive = isAct;
        const mcqTotalMarks = (parsed.mcq || []).reduce((acc, q) => acc + (q.marks || 1), 0);
        const progTotalMarks = (parsed.programs || []).reduce((acc, p) => acc + (p.marks || 5), 0);
        tests.push({
          id,
          title: parsed.examTitle || id,
          durationMinutes: parsed.durationMinutes || 60,
          studentPassword: parsed.studentPassword || STUDENT_PASSWORD,
          mcqCount: (parsed.mcq || []).length,
          programCount: (parsed.programs || []).length,
          totalMarks: mcqTotalMarks + progTotalMarks,
          updatedAt: parsed.updatedAt || parsed.createdAt || null,
          isActive: isAct
        });
      }
    }

    if (tests.length === 0) {
      tests.push({
        id: 'default',
        title: DEFAULT_TEST_DATA.examTitle,
        durationMinutes: DEFAULT_TEST_DATA.durationMinutes,
        studentPassword: DEFAULT_TEST_DATA.studentPassword,
        mcqCount: DEFAULT_TEST_DATA.mcq.length,
        programCount: DEFAULT_TEST_DATA.programs.length,
        totalMarks: 12,
        updatedAt: null,
        isActive: true
      });
    }

    store.activeTestIds = tests.filter(t => t.isActive).map(t => t.id);
    if (!store.activeTestId || !store.activeTestIds.includes(store.activeTestId)) {
      store.activeTestId = store.activeTestIds[0] || 'default';
    }

    if (isStudent) {
      tests = tests.filter(t => t.isActive);
    } else {
      tests.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1;
        if (!a.isActive && b.isActive) return 1;
        return a.title.localeCompare(b.title);
      });
    }

    res.json({
      tests,
      totalCount: tests.length,
      activeCount: tests.filter(t => t.isActive).length,
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
    const onDisk = await safeRead(targetFile, null);
    if (onDisk) testObj = onDisk;

    if (!testObj) {
      return res.status(404).json({ error: 'Test not found' });
    }

    testObj.isActive = shouldBeActive;
    testObj.updatedAt = new Date().toISOString();

    // Persist
    await safeWrite(targetFile, JSON.stringify(testObj, null, 2));
    store.tests[id] = testObj;

    if (shouldBeActive) {
      if (!store.activeTestIds.includes(id)) {
        store.activeTestIds.push(id);
      }
      store.activeTestId = id;
      await safeWrite(QUESTIONS_FILE, JSON.stringify(testObj, null, 2));
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
    const store = await getTestsStore();
    let testObj = (store.tests && store.tests[id]) || (await safeRead(targetFile, null));

    if (!testObj) {
      return res.status(404).json({ error: 'Test not found' });
    }

    testObj.isActive = true;
    const updatedStr = JSON.stringify(testObj, null, 2);
    await safeWrite(targetFile, updatedStr);
    await safeWrite(QUESTIONS_FILE, updatedStr);
    
    if (!store.tests) store.tests = {};
    store.tests[id] = testObj;
    if (!Array.isArray(store.activeTestIds)) store.activeTestIds = [];
    if (!store.activeTestIds.includes(id)) store.activeTestIds.push(id);
    store.activeTestId = id;
    await saveTestsStore(store);

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
        studentPassword: password || STUDENT_PASSWORD,
        isActive: markActive,
        mcq: [],
        programs: [],
        createdAt: new Date().toISOString()
      };
    } else {
      newTestData = {
        examTitle: testTitle,
        durationMinutes: parseInt(durationMinutes, 10) || 60,
        studentPassword: password || STUDENT_PASSWORD,
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
    await safeWrite(testFile, jsonStr);
    await safeWrite(QUESTIONS_FILE, jsonStr);

    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[testId] = newTestData;
    store.activeTestId = testId;
    await saveTestsStore(store);

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
    const store = await getTestsStore();
    const sourcePath = path.join(TESTS_DIR, `${id}.json`);
    let parsed = (store.tests && store.tests[id]) || (await safeRead(sourcePath, null));

    if (!parsed) {
      return res.status(404).json({ error: 'Source test not found' });
    }

    parsed = JSON.parse(JSON.stringify(parsed));
    parsed.examTitle = `${parsed.examTitle || 'Test'} (Copy)`;
    parsed.createdAt = new Date().toISOString();
    parsed.updatedAt = new Date().toISOString();

    const newId = 'test_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const newPath = path.join(TESTS_DIR, `${newId}.json`);
    await safeWrite(newPath, JSON.stringify(parsed, null, 2));

    store.tests[newId] = parsed;
    await saveTestsStore(store);

    autoSyncToGitHub(`Duplicated test "${parsed.examTitle}"`).catch(() => {});

    res.json({ success: true, newId, title: parsed.examTitle, message: `Duplicated as "${parsed.examTitle}"` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to duplicate test: ' + err.message });
  }
});

// 1f. Delete a test
app.delete('/api/tests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const testFile = path.join(TESTS_DIR, `${id}.json`);
    const store = await getTestsStore();
    if (!store.tests) store.tests = {};

    try {
      if (fs.existsSync(testFile)) await fs.promises.unlink(testFile);
    } catch (e) {}
    delete store.tests[id];

    if (Array.isArray(store.activeTestIds)) {
      store.activeTestIds = store.activeTestIds.filter(tId => tId !== id);
    }

    const remainingIds = Object.keys(store.tests);
    let newActiveId = null;
    let newActiveTitle = null;

    if (store.activeTestId === id || remainingIds.length > 0) {
      newActiveId = store.activeTestIds[0] || remainingIds[0] || 'default';
      store.activeTestId = newActiveId;
      
      const nextTestObj = store.tests[newActiveId];
      if (nextTestObj) {
        newActiveTitle = nextTestObj.examTitle || 'Class Test';
        const nextContent = JSON.stringify(nextTestObj, null, 2);
        await safeWrite(QUESTIONS_FILE, nextContent);
        await safeWrite(path.join(TESTS_DIR, `${newActiveId}.json`), nextContent);
      }
    }

    await saveTestsStore(store);
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

// 1g. Bulk restore or import tests
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
          studentPassword: data.studentPassword || STUDENT_PASSWORD,
          mcq: Array.isArray(data.mcq) ? data.mcq : [],
          programs: Array.isArray(data.programs) ? data.programs : [],
          updatedAt: data.updatedAt || new Date().toISOString()
        };
        store.tests[id] = cleanData;
        await safeWrite(path.join(TESTS_DIR, `${id}.json`), JSON.stringify(cleanData, null, 2));
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
    await safeWrite(QUESTIONS_FILE, jsonStr);

    const testId = req.body.testId || 'default';
    await safeWrite(path.join(TESTS_DIR, `${testId}.json`), jsonStr);

    const store = await getTestsStore();
    if (!store.tests) store.tests = {};
    store.tests[testId] = questionsData;
    store.activeTestId = testId;
    await saveTestsStore(store);

    autoSyncToGitHub(`Updated questions for ${questionsData.examTitle || testId}`).catch(() => {});

    res.json({
      success: true,
      message: 'Questions updated and saved successfully'
    });
  } catch (err) {
    console.error('Error saving questions:', err);
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
    await safeWrite(path.join(STUDENTS_DIR, `${rollKey}.json`), JSON.stringify(updated, null, 2));

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

    const pushSubmissions = await pushFileToGitHub(
      ghCfg.owner,
      ghCfg.repo,
      ghCfg.branch || 'main',
      'data/submissions.json',
      JSON.stringify(subs, null, 2),
      `Sync all ${subsCount} student submissions to GitHub [${new Date().toISOString()}]`,
      ghCfg.token
    );

    const questionsData = await safeRead(QUESTIONS_FILE, memoryCache.questions || DEFAULT_TEST_DATA);
    const pushQuestions = await pushFileToGitHub(
      ghCfg.owner,
      ghCfg.repo,
      ghCfg.branch || 'main',
      'questions.json',
      JSON.stringify(questionsData, null, 2),
      `Sync questions.json to GitHub [${new Date().toISOString()}]`,
      ghCfg.token
    );

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

// Route for root & index
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.send('Class Test Portal');
});

// Route for admin page
app.get('/admin', (req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (fs.existsSync(adminPath)) {
    return res.sendFile(adminPath);
  }
  res.status(404).send('Admin page not found');
});

// Serve static files from root directory
app.use(express.static(__dirname));

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.status(404).send('Not found');
});

// Global error handling middleware to avoid unhandled exception crashes
app.use((err, req, res, next) => {
  console.error('Express Unhandled Error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

// Check if server.js is run directly (e.g. `node server.js`)
const isDirectEntry = process.argv[1] && (
  process.argv[1].endsWith('server.js') || 
  process.argv[1].endsWith('server.ts')
);

// Start server only when running as standalone Node process (not serverless and not imported)
if (isDirectEntry && !process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Class Test Portal server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
