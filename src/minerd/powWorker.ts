// src/minerd/powWorker.ts
import { parentPort } from 'node:worker_threads';
import { powHash } from '../crypto/pow.js';
import { hashMeetsTarget, hexToBytes } from '../util/binary.js';

const NONCE_OFFSET = 112; // u32 nonce position in the 148-byte header (see miner/miner.worker.ts)
const HASHRATE_REPORT_MS = 1000;

if (!parentPort) throw new Error('powWorker must run as a worker thread');
const port = parentPort;

type VerifyMsg = { type: 'verify'; id: number; headerHex: string; targetHex: string };
type GrindMsg = { type: 'grind'; gen: number; headerHex: string; targetHex: string; start: number; end: number; throttle: number; continuous?: boolean };
type StopMsg = { type: 'stop' };
type SetThrottleMsg = { type: 'setThrottle'; throttle: number };
type Msg = VerifyMsg | GrindMsg | StopMsg | SetThrottleMsg;

let currentGen = -1;
let liveThrottle = 1;

function writeNonceBE(header: Uint8Array, nonce: number): void {
  header[NONCE_OFFSET] = (nonce >>> 24) & 0xff;
  header[NONCE_OFFSET + 1] = (nonce >>> 16) & 0xff;
  header[NONCE_OFFSET + 2] = (nonce >>> 8) & 0xff;
  header[NONCE_OFFSET + 3] = nonce & 0xff;
}

port.on('message', (msg: Msg) => {
  if (msg.type === 'setThrottle') {
    liveThrottle = Math.min(1, Math.max(0.05, msg.throttle));
    return;
  }
  if (msg.type === 'stop') {
    currentGen = -1;
    return;
  }
  if (msg.type === 'verify') {
    void verify(msg);
    return;
  }
  if (msg.type === 'grind') {
    currentGen = msg.gen;
    void grind(msg);
  }
});

async function verify(msg: VerifyMsg): Promise<void> {
  const target = BigInt('0x' + msg.targetHex);
  let ok = false;
  try {
    const h = await powHash(hexToBytes(msg.headerHex));
    ok = hashMeetsTarget(h, target);
  } catch {
    ok = false;
  }
  port.postMessage({ type: 'verified', id: msg.id, ok });
}

async function grind(msg: GrindMsg): Promise<void> {
  const header = hexToBytes(msg.headerHex); // our own mutable copy
  const target = BigInt('0x' + msg.targetHex);
  const myGen = msg.gen;
  liveThrottle = Math.min(1, Math.max(0.05, msg.throttle)); // duty cycle
  let hashes = 0;
  let lastReport = Date.now();

  for (let nonce = msg.start; nonce < msg.end; nonce++) {
    const throttle = liveThrottle;
    if (currentGen !== myGen) return; // superseded by a stop/new template
    writeNonceBE(header, nonce);
    let h: Uint8Array;
    const t0 = Date.now();
    try {
      h = await powHash(header);
    } catch {
      port.postMessage({ type: 'oom', gen: myGen });
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    hashes++;
    if (hashMeetsTarget(h, target)) {
      port.postMessage({ type: 'solved', gen: myGen, nonce, hash: h });
      // Solo: one solution = one block, stop and rebuild the template.
      // Pool (continuous): each hit is a share — keep grinding the rest of the
      // assigned slot for more shares, advancing past this nonce so we never
      // resubmit it.
      if (!msg.continuous) return;
    }
    // Duty-cycle throttle: rest in proportion to the time just spent hashing,
    // so sustained CPU (heat/fan/power) is capped at ~throttle. 1 = full blast.
    if (throttle < 1) {
      const workMs = Date.now() - t0;
      const sleepMs = Math.min(1000, (workMs * (1 - throttle)) / throttle);
      if (sleepMs >= 1) await new Promise((r) => setTimeout(r, sleepMs));
    }
    const now = Date.now();
    if (now - lastReport >= HASHRATE_REPORT_MS) {
      port.postMessage({ type: 'hashrate', gen: myGen, hashes });
      hashes = 0;
      lastReport = now;
    }
  }
  port.postMessage({ type: 'exhausted', gen: myGen });
}
