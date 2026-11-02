const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  EngineLifecycleState,
  PythonEngine,
  PythonEngineError,
  discoverPython,
} = require('../out/pythonEngine.js');

function fakeRun(command, args) {
  if (args.includes('--version')) {
    return Promise.resolve({ stdout: 'Python 3.11.0', stderr: '' });
  }
  const code = args[args.indexOf('-c') + 1];
  if (code) {
    if (command.includes('bin') || command.includes('Scripts')) {
      return Promise.resolve({ stdout: '3.12\n', stderr: '' });
    }
    return Promise.resolve({ stdout: JSON.stringify({ major: 3, minor: 12, micro: 1, version: '3.12.1' }), stderr: '' });
  }
  return Promise.resolve({ stdout: '', stderr: '' });
}

test('discovers a compatible interpreter and rejects incompatible Python', async () => {
  const interpreter = await discoverPython([{ command: 'python', args: [] }], fakeRun);
  assert.equal(interpreter.version, '3.12.1');

  const incompatibleRun = async () => ({ stdout: 'Python 3.11.0', stderr: '' });
  await assert.rejects(
    discoverPython([{ command: 'python', args: [] }], incompatibleRun),
    (error) => error instanceof PythonEngineError && error.code === 'PYTHON_INCOMPATIBLE',
  );
  await assert.rejects(
    discoverPython([{ command: 'missing-python', args: [] }], async () => {
      throw new Error('not found');
    }),
    (error) => error instanceof PythonEngineError && error.code === 'PYTHON_MISSING',
  );
});

test('does not overwrite an existing incompatible virtual environment', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const incompatibleRun = async (command, args) => {
    if (args.includes('-c') && command.includes('bin')) {
      return { stdout: '3.11\n', stderr: '' };
    }
    return fakeRun(command, args);
  };
  await assert.rejects(
    require('../out/pythonEngine.js').ensureEngineEnvironment(
      { command: 'python', args: [], version: '3.12.1' },
      environmentPath,
      'linux',
      incompatibleRun,
    ),
    (error) => error instanceof PythonEngineError && error.code === 'PYTHON_INCOMPATIBLE',
  );
  rmSync(root, { recursive: true, force: true });
});

test('does not pass an existing non-environment directory to venv', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'existing');
  mkdirSync(environmentPath, { recursive: true });
  writeFileSync(path.join(environmentPath, 'keep.txt'), 'preserve');
  await assert.rejects(
    require('../out/pythonEngine.js').ensureEngineEnvironment(
      { command: 'python', args: [], version: '3.12.1' },
      environmentPath,
      'linux',
      fakeRun,
    ),
    (error) => error instanceof PythonEngineError && error.code === 'ENGINE_STARTUP_FAILED',
  );
  assert.equal(require('node:fs').readFileSync(path.join(environmentPath, 'keep.txt'), 'utf8'), 'preserve');
  rmSync(root, { recursive: true, force: true });
});

test('starts once, waits for ready, times out, and shuts down cleanly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  const manager = new PythonEngine({
    sourcePath: root,
    environmentPath,
    platform: 'linux',
    pythonCandidates: [{ command: 'python', args: [] }],
    execFile: fakeRun,
    spawn: () => child,
    startupTimeoutMs: 50,
  });
  const first = manager.start();
  const second = manager.start();
  child.stdout.write('{"protocol_version":"1","type":"event","event":"ready"}\n');
  await Promise.all([first, second]);
  assert.equal(manager.lifecycleState, EngineLifecycleState.RUNNING);
  await manager.stop();
  assert.equal(manager.lifecycleState, EngineLifecycleState.STOPPED);
  rmSync(root, { recursive: true, force: true });
});

test('reports startup timeout', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  await assert.rejects(
    new PythonEngine({
      sourcePath: root,
      environmentPath,
      platform: 'linux',
      pythonCandidates: [{ command: 'python', args: [] }],
      execFile: fakeRun,
      spawn: () => child,
      startupTimeoutMs: 10,
    }).start(),
    (error) => error instanceof PythonEngineError && error.code === 'ENGINE_TIMEOUT',
  );
  rmSync(root, { recursive: true, force: true });
});

test('moves to ERROR when the child process exits unexpectedly', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  const manager = new PythonEngine({
    sourcePath: root,
    environmentPath,
    platform: 'linux',
    pythonCandidates: [{ command: 'python', args: [] }],
    execFile: fakeRun,
    spawn: () => child,
    startupTimeoutMs: 100,
  });
  const start = manager.start();
  child.emit('exit', 1, null);
  await assert.rejects(start);
  assert.equal(manager.lifecycleState, EngineLifecycleState.ERROR);
  rmSync(root, { recursive: true, force: true });
});

test('delivers ordered streaming events and terminal response by request', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  const manager = new PythonEngine({
    sourcePath: root,
    environmentPath,
    platform: 'linux',
    pythonCandidates: [{ command: 'python', args: [] }],
    execFile: fakeRun,
    spawn: () => child,
    startupTimeoutMs: 100,
  });
  const start = manager.start();
  child.stdout.write('{"protocol_version":"1","type":"event","event":"ready"}\n');
  await start;
  const tokens = [];
  const responsePromise = manager.request('explain_code', {
    model: 'model',
    code: "print('hello')",
    question: 'What does this do?',
  }, (event) => tokens.push(event.text));
  const requestLine = await new Promise((resolve) => {
    child.stdin.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  assert.equal(requestLine.code, "print('hello')");
  assert.equal(requestLine.language, 'python');
  assert.equal(requestLine.question, 'What does this do?');
  assert.equal(requestLine.options.code, undefined);
  assert.equal(requestLine.options.question, undefined);
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'event', request_id: requestLine.request_id,
    event: 'token', sequence: 1, text: 'First ',
  }) + '\n');
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'event', request_id: requestLine.request_id,
    event: 'token', sequence: 2, text: 'second.',
  }) + '\n');
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'response', request_id: requestLine.request_id,
    status: 'ok', task: 'explain_code', message: 'First second.',
  }) + '\n');
  const response = await responsePromise;
  assert.deepEqual(tokens, ['First ', 'second.']);
  assert.equal(response.message, 'First second.');
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
});

test('rejects duplicate or out-of-order streaming events', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  const manager = new PythonEngine({
    sourcePath: root, environmentPath, platform: 'linux',
    pythonCandidates: [{ command: 'python', args: [] }],
    execFile: fakeRun, spawn: () => child, startupTimeoutMs: 100,
  });
  const start = manager.start();
  child.stdout.write('{"protocol_version":"1","type":"event","event":"ready"}\n');
  await start;
  const responsePromise = manager.request('explain_code');
  const requestLine = await new Promise((resolve) => {
    child.stdin.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'event', request_id: requestLine.request_id,
    event: 'token', sequence: 2, text: 'wrong',
  }) + '\n');
  await assert.rejects(responsePromise, /out-of-order/);
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
});

test('sends cancellation and permits a retry after the terminal error', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'localdev-ai-'));
  const environmentPath = path.join(root, 'venv');
  mkdirSync(path.join(environmentPath, 'bin'), { recursive: true });
  writeFileSync(path.join(environmentPath, 'bin', 'python'), '');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => true;
  const manager = new PythonEngine({
    sourcePath: root, environmentPath, platform: 'linux',
    pythonCandidates: [{ command: 'python', args: [] }],
    execFile: fakeRun, spawn: () => child, startupTimeoutMs: 100,
  });
  const start = manager.start();
  child.stdout.write('{"protocol_version":"1","type":"event","event":"ready"}\n');
  await start;
  let cancelListener;
  const cancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      cancelListener = listener;
      return { dispose() {} };
    },
  };
  const responsePromise = manager.request('explain_code', {}, undefined, cancellationToken);
  const requestLine = await new Promise((resolve) => {
    child.stdin.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  cancelListener();
  const cancelLine = await new Promise((resolve) => {
    child.stdin.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  assert.equal(cancelLine.type, 'cancel');
  assert.equal(cancelLine.request_id, requestLine.request_id);
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'error', request_id: requestLine.request_id,
    code: 'REQUEST_CANCELLED', message: 'The explanation request was cancelled.',
  }) + '\n');
  await assert.rejects(responsePromise, /request was cancelled/);
  const retry = manager.request('check_setup');
  const retryLine = await new Promise((resolve) => {
    child.stdin.once('data', (data) => resolve(JSON.parse(String(data))));
  });
  child.stdout.write(JSON.stringify({
    protocol_version: '1', type: 'response', request_id: retryLine.request_id,
    status: 'ok', task: 'check_setup', message: {},
  }) + '\n');
  await retry;
  await manager.stop();
  rmSync(root, { recursive: true, force: true });
});
