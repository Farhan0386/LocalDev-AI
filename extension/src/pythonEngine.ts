import { execFile as defaultExecFile, spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(defaultExecFile);

export const ENGINE_STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const PROTOCOL_VERSION = '1';

export enum EngineLifecycleState {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
  ERROR = 'ERROR',
}

export interface PythonInterpreter {
  command: string;
  args: string[];
  version: string;
}

export interface EnginePaths {
  environmentPath: string;
  sourcePath: string;
}

export interface EngineProcess {
  stdin: { end(): void; write(data: string): void };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): EngineProcess['stdout'] };
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): EngineProcess['stderr'] };
  once(event: 'error', listener: (error: Error) => void): EngineProcess;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): EngineProcess;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): EngineProcess;
  kill(signal?: NodeJS.Signals | number): boolean;
  exitCode: number | null;
  killed: boolean;
}

export type SpawnEngine = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => EngineProcess;

export interface EngineManagerOptions {
  sourcePath: string;
  environmentPath: string;
  pythonCandidates?: Array<{ command: string; args?: string[] }>;
  execFile?: typeof execFile;
  spawn?: SpawnEngine;
  startupTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

export interface EngineResponse {
  type: 'response' | 'error' | 'event';
  request_id?: string;
  message?: unknown;
  [key: string]: unknown;
}

export interface EngineTokenEvent {
  type: 'event';
  event: 'token';
  request_id: string;
  sequence: number;
  text: string;
}

type RequestEventHandler = (event: EngineTokenEvent) => void;

export interface EngineCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export class PythonEngineError extends Error {
  constructor(message: string, public readonly code: 'PYTHON_MISSING' | 'PYTHON_INCOMPATIBLE' | 'ENGINE_STARTUP_FAILED' | 'ENGINE_TIMEOUT') {
    super(message);
    this.name = 'PythonEngineError';
  }
}

interface PythonVersionResult {
  major: number;
  minor: number;
  micro: number;
  version: string;
}

async function checkPython(
  candidate: { command: string; args: string[] },
  run: typeof execFile,
): Promise<PythonInterpreter | undefined> {
  try {
    const result = await run(candidate.command, [...candidate.args, '-c', 'import json, sys; print(json.dumps({"major": sys.version_info.major, "minor": sys.version_info.minor, "micro": sys.version_info.micro, "version": sys.version.split()[0]}))']);
    const parsed = JSON.parse(result.stdout.trim()) as PythonVersionResult;
    if (parsed.major !== 3 || parsed.minor < 12) {
      return undefined;
    }
    return { command: candidate.command, args: candidate.args, version: parsed.version };
  } catch {
    return undefined;
  }
}

interface PendingRequest {
  resolve: (response: EngineResponse) => void;
  reject: (error: Error) => void;
  onEvent?: RequestEventHandler;
  lastSequence: number;
  cancellationDisposable?: { dispose(): void };
  cancelSent: boolean;
}

export async function discoverPython(
  candidates: Array<{ command: string; args?: string[] }> = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }],
  run: typeof execFile = execFile,
): Promise<PythonInterpreter> {
  let foundIncompatible = false;
  for (const candidate of candidates) {
    const interpreter = await checkPython({ command: candidate.command, args: candidate.args ?? [] }, run);
    if (interpreter) {
      return interpreter;
    }
    try {
      const result = await run(candidate.command, [...(candidate.args ?? []), '--version']);
      if (result.stdout || result.stderr) {
        foundIncompatible = true;
      }
    } catch {
      // The next candidate may be available.
    }
  }
  if (foundIncompatible) {
    throw new PythonEngineError('Python 3.12 or newer is required. Install a compatible Python and retry.', 'PYTHON_INCOMPATIBLE');
  }
  throw new PythonEngineError('Python was not found. Install Python 3.12 or newer and ensure it is available on PATH.', 'PYTHON_MISSING');
}

function virtualEnvironmentPython(environmentPath: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(environmentPath, 'Scripts', 'python.exe')
    : path.join(environmentPath, 'bin', 'python');
}

export async function ensureEngineEnvironment(
  interpreter: PythonInterpreter,
  environmentPath: string,
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
): Promise<string> {
  const environmentPython = virtualEnvironmentPython(environmentPath, platform);
  if (!existsSync(environmentPython)) {
    if (existsSync(environmentPath)) {
      throw new PythonEngineError('The LocalDev AI environment path already exists but is not a valid virtual environment. Choose a new location or remove it manually; existing files were not changed.', 'ENGINE_STARTUP_FAILED');
    }
    await mkdir(path.dirname(environmentPath), { recursive: true });
    await run(interpreter.command, [...interpreter.args, '-m', 'venv', environmentPath]);
  }
  if (!existsSync(environmentPython)) {
    throw new PythonEngineError('The LocalDev AI virtual environment could not be created. Check Python permissions and retry.', 'ENGINE_STARTUP_FAILED');
  }
  try {
    const result = await run(environmentPython, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
    const [major, minor] = result.stdout.trim().split('.').map(Number);
    if (major !== 3 || minor < 12) {
      throw new PythonEngineError('The existing LocalDev AI virtual environment uses Python older than 3.12. Remove that environment manually or configure a new location, then retry.', 'PYTHON_INCOMPATIBLE');
    }
  } catch (error) {
    if (error instanceof PythonEngineError) {
      throw error;
    }
    throw new PythonEngineError('The existing LocalDev AI virtual environment could not be validated. Check its permissions or configure a new location; it was not overwritten.', 'ENGINE_STARTUP_FAILED');
  }
  return environmentPython;
}

export class PythonEngine {
  private state = EngineLifecycleState.STOPPED;
  private process?: EngineProcess;
  private startPromise?: Promise<void>;
  private outputBuffer = '';
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private stopRequested = false;
  private requestSequence = 0;
  private activeInferenceRequest?: string;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  constructor(private readonly options: EngineManagerOptions) {}

  get lifecycleState(): EngineLifecycleState {
    return this.state;
  }

  async request(
    task: string,
    options: Record<string, unknown> = {},
    onEvent?: RequestEventHandler,
    cancellationToken?: EngineCancellationToken,
  ): Promise<EngineResponse> {
    await this.start();
    if (this.state !== EngineLifecycleState.RUNNING || !this.process) {
      throw new PythonEngineError('The Python engine is not running.', 'ENGINE_STARTUP_FAILED');
    }
    const requestId = `request-${Date.now()}-${++this.requestSequence}`;
    if (task === 'explain_code' && this.activeInferenceRequest) {
      throw new Error('An explanation request is already active. Wait for it to finish before retrying.');
    }
    const requestFields = task === 'explain_code'
      ? { language: 'python', code: options.code, question: options.question }
      : {};
    const protocolOptions = task === 'explain_code'
      ? Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'code' && key !== 'question'))
      : options;
    const message = JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      type: 'request',
      request_id: requestId,
      task,
      options: protocolOptions,
      ...requestFields,
    });
    return new Promise<EngineResponse>((resolve, reject) => {
      if (task === 'explain_code') {
        this.activeInferenceRequest = requestId;
      }
      const pending: PendingRequest = { resolve, reject, onEvent, lastSequence: 0, cancelSent: false };
      this.pendingRequests.set(requestId, pending);
      if (cancellationToken) {
        pending.cancellationDisposable = cancellationToken.onCancellationRequested(() => this.cancel(requestId));
        if (cancellationToken.isCancellationRequested) {
          this.cancel(requestId);
        }
      }
      this.process?.stdin.write(`${message}\n`);
    });
  }

  cancel(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.cancelSent || !this.process || this.state !== EngineLifecycleState.RUNNING) {
      return;
    }
    pending.cancelSent = true;
    this.process.stdin.write(`${JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      type: 'cancel',
      request_id: requestId,
    })}\n`);
  }

  async start(): Promise<void> {
    if (this.state === EngineLifecycleState.RUNNING) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.state = EngineLifecycleState.STARTING;
    this.stopRequested = false;
    try {
      const run = this.options.execFile ?? execFile;
      const interpreter = await discoverPython(this.options.pythonCandidates, run);
      const environmentPython = await ensureEngineEnvironment(
        interpreter,
        this.options.environmentPath,
        this.options.platform ?? process.platform,
        run,
      );
      if (this.stopRequested) {
        this.state = EngineLifecycleState.STOPPED;
        return;
      }
      const spawn = this.options.spawn ?? (defaultSpawn as unknown as SpawnEngine);
      const child = spawn(environmentPython, ['-m', 'localdev_ai_engine'], {
        cwd: this.options.sourcePath,
        env: { ...process.env, PYTHONPATH: this.options.sourcePath },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.process = child;
      child.stdout.on('data', (chunk: Buffer | string) => this.handleStdout(String(chunk)));
      child.stderr.on('data', (chunk: Buffer | string) => {
        process.stderr.write(`[LocalDev AI engine] ${String(chunk)}`);
      });
      child.once('error', (error: Error) => this.handleProcessFailure(error));
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.state !== EngineLifecycleState.STOPPING && this.state !== EngineLifecycleState.STOPPED) {
          this.handleProcessFailure(new Error(`The Python engine exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`));
        }
      });
      await new Promise<void>((resolve, reject) => {
        this.startupResolve = resolve;
        this.startupReject = reject;
        this.startupTimer = setTimeout(() => {
          this.handleProcessFailure(new PythonEngineError('The Python engine did not become ready within 20 seconds. Check Python and engine setup, then retry.', 'ENGINE_TIMEOUT'));
        }, this.options.startupTimeoutMs ?? ENGINE_STARTUP_TIMEOUT_MS);
      });
      this.state = EngineLifecycleState.RUNNING;
    } catch (error) {
      this.state = this.stopRequested ? EngineLifecycleState.STOPPED : EngineLifecycleState.ERROR;
      await this.cleanupProcess();
      throw error;
    }
  }

  private handleStdout(chunk: string): void {
    this.outputBuffer += chunk;
    let newlineIndex = this.outputBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.outputBuffer.slice(0, newlineIndex).trim();
      this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
      newlineIndex = this.outputBuffer.indexOf('\n');
      if (!line) {
        continue;
      }
      try {
        const message = JSON.parse(line) as EngineResponse & { protocol_version?: string; event?: string };
        if (message.protocol_version !== PROTOCOL_VERSION) {
          throw new Error('Unsupported engine protocol version.');
        }
        if (message.type === 'event' && message.event === 'ready') {
          this.startupResolve?.();
          this.startupResolve = undefined;
          this.startupReject = undefined;
          if (this.startupTimer) clearTimeout(this.startupTimer);
        } else if (message.type === 'event' && message.event === 'token' && message.request_id) {
          const pending = this.pendingRequests.get(message.request_id);
          if (!pending) {
            continue;
          }
          if (
            typeof message.sequence !== 'number'
            || !Number.isInteger(message.sequence)
            || message.sequence !== pending.lastSequence + 1
            || typeof message.text !== 'string'
          ) {
            this.pendingRequests.delete(message.request_id);
            pending.cancellationDisposable?.dispose();
            if (message.request_id === this.activeInferenceRequest) {
              this.activeInferenceRequest = undefined;
            }
            pending.reject(new Error('The engine sent an invalid or out-of-order streaming event.'));
            continue;
          }
          pending.lastSequence = message.sequence;
          pending.onEvent?.({
            type: 'event',
            event: 'token',
            request_id: message.request_id,
            sequence: message.sequence,
            text: message.text,
          });
        } else if ((message.type === 'response' || message.type === 'error') && message.request_id) {
          const pending = this.pendingRequests.get(message.request_id);
          if (pending) {
            this.pendingRequests.delete(message.request_id);
            pending.cancellationDisposable?.dispose();
            if (message.request_id === this.activeInferenceRequest) {
              this.activeInferenceRequest = undefined;
            }
            if (message.type === 'response') {
              pending.resolve(message);
            } else {
              const messageText = typeof message.message === 'string' ? message.message : 'The engine request failed.';
              const action = typeof message.action === 'string' ? ` ${message.action}` : '';
              pending.reject(new Error(`${messageText}${action}`));
            }
          }
        }
      } catch (error) {
        this.handleProcessFailure(new PythonEngineError(`The Python engine sent invalid startup data: ${String(error)}`, 'ENGINE_STARTUP_FAILED'));
      }
    }
  }

  private handleProcessFailure(error: Error): void {
    if (this.startupReject) {
      this.startupReject(error);
      this.startupResolve = undefined;
      this.startupReject = undefined;
      if (this.startupTimer) clearTimeout(this.startupTimer);
    }
    if (this.state !== EngineLifecycleState.STOPPING && this.state !== EngineLifecycleState.STOPPED) {
      this.state = EngineLifecycleState.ERROR;
    }
    for (const pending of this.pendingRequests.values()) {
      pending.cancellationDisposable?.dispose();
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.activeInferenceRequest = undefined;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.state === EngineLifecycleState.STARTING && this.startupReject) {
      this.startupReject(new Error('The engine start was cancelled during extension shutdown.'));
      this.startupResolve = undefined;
      this.startupReject = undefined;
      if (this.startupTimer) clearTimeout(this.startupTimer);
    }
    if (!this.process) {
      this.state = EngineLifecycleState.STOPPED;
      return;
    }
    this.state = EngineLifecycleState.STOPPING;
    this.process.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.process && !this.process.killed && this.process.exitCode === null) {
          this.process.kill();
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
      this.process?.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.cleanupProcess();
    this.state = EngineLifecycleState.STOPPED;
  }

  private async cleanupProcess(): Promise<void> {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.process && !this.process.killed && this.process.exitCode === null) {
      this.process.kill();
    }
    this.process = undefined;
    this.outputBuffer = '';
    for (const pending of this.pendingRequests.values()) {
      pending.cancellationDisposable?.dispose();
      pending.reject(new Error('The Python engine stopped before the request completed.'));
    }
    this.pendingRequests.clear();
    this.activeInferenceRequest = undefined;
  }
}
