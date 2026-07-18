// CUDA grind pool — a drop-in grinder for the reusable CUDA helper in
// cuda-poc/brc-argon-cuda-helper. Pool networking remains in poolClient.ts;
// this class only owns a long-lived CUDA process and translates its records.

import { existsSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBytes } from '../util/binary.js';
import { NONCE_SPACE } from './partition.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXE = process.platform === 'win32' ? '.exe' : '';
export const CUDA_HELPER_BIN = resolve(__dirname, `../../cuda-poc/brc-argon-cuda-helper${EXE}`);
export const CUDA_WORKSPACE_MIB_PER_NONCE = 32;

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function cudaHelperAvailable(path = CUDA_HELPER_BIN): boolean {
  return existsSync(path);
}

/** Check the CUDA runtime before pool registration starts grinding. A helper
 * binary can exist while its driver/toolkit pair is unusable; in that case the
 * caller can select WASM immediately instead of starting a dead grinder. */
export function cudaRuntimeAvailable(path = CUDA_HELPER_BIN): boolean {
  if (!cudaHelperAvailable(path)) return false;
  try {
    return spawnSync(path, ['--probe'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

export function resolveCudaBatch(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MINER_CUDA_BATCH;
  if (raw == null || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export type CudaSolved = (nonce: number, hash: Uint8Array) => void;
export type CudaHashrate = (hashesPerSecond: number) => void;
export type CudaExhausted = () => void;
export type CudaError = (error: Error) => void;
export type CudaInfo = (message: string) => void;

/** One helper owns the complete pool-assigned slot. The CUDA library batches
 * up to 256 nonces per launch and reuses its context/workspace between launches. */
export class CudaGrindPool {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: Interface | null = null;
  private stderr: Interface | null = null;
  private generation = 0;
  private stopping = false;
  private active = false;
  private onSolved: CudaSolved = () => {};
  private onHashrate: CudaHashrate = () => {};
  private onExhausted: CudaExhausted = () => {};
  private onError: CudaError = () => {};
  private onInfo: CudaInfo = () => {};
  private throttle: number;
  private jobToken = 0;

  constructor(
    _workerCount: number,
    throttle = 1,
    private readonly helper = CUDA_HELPER_BIN,
    private readonly batchSize = resolveCudaBatch(),
  ) {
    this.throttle = Math.min(1, Math.max(0.05, throttle));
  }

  setThrottle(throttle: number): void {
    this.throttle = Math.min(1, Math.max(0.05, throttle));
    if (this.child?.stdin.writable) this.child.stdin.write(`THROTTLE ${this.throttle}\n`);
  }

  setInfoLogger(onInfo: CudaInfo): void {
    this.onInfo = onInfo;
  }

  start(
    headerBytes: Uint8Array,
    targetHex: string,
    onSolved: CudaSolved,
    onHashrate: CudaHashrate,
    onExhausted: CudaExhausted = () => {},
    onError: CudaError = () => {},
    nonceStart = 0,
    nonceEnd = NONCE_SPACE,
    continuous = false,
  ): void {
    const existing = this.child;
    const reuse = !this.stopping && existing !== null
      && existing.exitCode === null && existing.signalCode === null
      && existing.stdin.writable;
    if (!reuse) this.stop();
    this.generation++;
    this.onSolved = onSolved;
    this.onHashrate = onHashrate;
    this.onExhausted = onExhausted;
    this.onError = onError;
    this.stopping = false;
    this.active = true;

    if (!cudaHelperAvailable(this.helper)) {
      this.active = false;
      throw new Error(`CUDA helper not found: ${this.helper} (build with make -C cuda-poc cuda-helper)`);
    }
    if (!Number.isInteger(nonceStart) || !Number.isInteger(nonceEnd)
      || nonceStart < 0 || nonceStart >= nonceEnd || nonceEnd > NONCE_SPACE) {
      this.active = false;
      throw new Error('invalid CUDA nonce range');
    }

    let child = existing;
    if (!reuse) {
      try {
        child = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        this.active = false;
        throw error;
      }
      this.child = child;
      this.stdout = createInterface({ input: child.stdout });
      this.stderr = createInterface({ input: child.stderr });
      this.stdout.on('line', (line) => this.handleStdout(line));
      this.stderr.on('line', (line) => this.handleStderr(line));
      child.on('error', (error) => {
        if (this.child === child && !this.stopping) this.onError(error);
      });
      child.on('exit', (code, signal) => {
        // A rapid stop/start can leave the old child's exit event queued after
        // the replacement child is already installed. Never report that
        // intentional old-process exit as a live helper failure.
        if (this.child !== child || this.stopping) return;
        this.active = false;
        this.closeReaders();
        this.child = null;
        this.onError(new Error(`CUDA helper exited (code=${code}, signal=${signal ?? 'none'})`));
      });
    }

    const headerHex = Buffer.from(headerBytes).toString('hex');
    const token = ++this.jobToken;
    if (!child) throw new Error('CUDA helper process was not available');
    child.stdin.write(`START ${headerHex} ${targetHex} ${nonceStart} ${nonceEnd} ${this.throttle} ${continuous ? 1 : 0} ${this.batchSize} ${token}\n`);
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.stopping = true;
    this.closeProcess();
  }

  terminate(): void {
    this.stop();
  }

  respawn(): void {
    // The pool client will re-poll and call start with the current job after its
    // watchdog notices the missing hashrate. Do not retain stale header/target.
    this.stop();
  }

  private handleStdout(line: string): void {
    if (!this.active) return;
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'SOLVED' && fields.length === 4) {
      if (Number(fields[1]) !== this.jobToken) return;
      const nonce = Number(fields[2]);
      const hashHex = fields[3]!;
      if (!Number.isInteger(nonce) || nonce < 0 || nonce >= NONCE_SPACE || !HEX64.test(hashHex)) {
        this.onError(new Error('CUDA helper emitted an invalid SOLVED record'));
        return;
      }
      try {
        this.onSolved(nonce, hexToBytes(hashHex));
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } else if (fields[0] === 'EXHAUSTED' && fields.length === 2) {
      if (Number(fields[1]) !== this.jobToken) return;
      this.active = false;
      this.onExhausted();
    } else if (fields[0] === 'ERROR') {
      this.onError(new Error(fields.slice(1).join(' ') || 'CUDA helper error'));
    }
  }

  private handleStderr(line: string): void {
    if (!this.active) return;
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'CUDA_BATCH' || fields[0] === 'CUDA_MODE' || fields[0] === 'CUDA_JOB') {
      this.onInfo(line.trim());
      return;
    }
    if (fields[0] !== 'HASHRATE') return;
    if (Number(fields[1]) !== this.jobToken) return;
    const hps = Number(fields[2]);
    if (Number.isFinite(hps) && hps >= 0) this.onHashrate(hps);
  }

  private closeReaders(): void {
    this.stdout?.removeAllListeners();
    this.stderr?.removeAllListeners();
    this.stdout?.close();
    this.stderr?.close();
    this.stdout = null;
    this.stderr = null;
  }

  private closeProcess(): void {
    const child = this.child;
    this.closeReaders();
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
