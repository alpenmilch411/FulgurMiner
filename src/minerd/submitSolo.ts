// src/minerd/submitSolo.ts
import type { Block } from '../chain/block.js';
import type { Template } from './template.js';
import type { SubmitResult } from './http.js';
import { isHelperAccept } from './http.js';

export interface SubmitSoloDeps {
  chain: { addBlock(block: Block): Promise<string | null> };
  helpers: string[];
  postBlock: (base: string, block: Block) => Promise<SubmitResult>;
}

export interface SubmitSoloOutcome {
  block: Block;
  statuses: string[];
  /** ≥1 helper confirmed the network has the block (isHelperAccept). */
  helperAccepted: boolean;
  /** Broadcast rounds performed. */
  attempts: number;
  /** True once the block was adopted into the local chain (only after helperAccepted). */
  adopted: boolean;
  /** chain.addBlock error if adoption was attempted and failed; null otherwise. */
  localError: string | null;
}

export interface SubmitSoloOptions {
  maxBroadcastAttempts?: number;
  rebroadcastDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Broadcast-first-then-adopt: broadcast a solved solo block to ALL helpers
 * first, and adopt it into the local chain ONLY after ≥1 helper confirms the network
 * has it. The old path (submit.ts) adopted locally FIRST, so if every broadcast
 * failed — or an equal-height public block already existed — the miner sat on a
 * private fork that equal-cumulative-work never replaces, and kept building on it.
 *
 * Solo blocks are extremely rare (a small solo miner ≈ never finds one), so the one
 * broadcast round-trip per found block costs negligible throughput, while the safety
 * (never mine a private fork the network rejected) is the whole point of solo mode.
 *
 * If no helper accepts, the block is NOT adopted: the miner keeps grinding the
 * current tip (the solve is dropped, not forked onto). Pure — deps injected.
 * submit.ts (the old adopt-first primitive) is intentionally left byte-identical and
 * unused, to keep the consensus block-assembly path untouched; this lives in a fresh file.
 */
export async function submitSoloBlock(
  deps: SubmitSoloDeps,
  template: Template,
  nonce: number,
  opts: SubmitSoloOptions = {},
): Promise<SubmitSoloOutcome> {
  // Byte-identical block assembly to the old path (header + nonce, no txs).
  const block: Block = { header: { ...template.header, nonce }, transactions: [] };
  const maxBroadcastAttempts = opts.maxBroadcastAttempts ?? 3;
  const rebroadcastDelayMs = opts.rebroadcastDelayMs ?? 1500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Broadcast FIRST — only adopt once the network confirms it has the block.
  let statuses: string[] = [];
  let helperAccepted = false;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxBroadcastAttempts; attempt++) {
    attempts = attempt;
    const results = await Promise.allSettled(deps.helpers.map((h) => deps.postBlock(h, block)));
    statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : `error:${(r.reason as Error).message}`));
    helperAccepted = statuses.some(isHelperAccept);
    if (helperAccepted) break;
    if (attempt < maxBroadcastAttempts) await sleep(rebroadcastDelayMs);
  }

  // Adoption gate = "≥1 helper STORED the block" (isHelperAccept), NOT "a helper made
  // it CANONICAL". This is deliberate and safe — gating on canonicality was reviewed
  // and rejected. Why it can't strand us on a fork:
  //   • Our own block ALWAYS becomes the local tip: buildTemplate pins prevHash=chain.tip,
  //     so addBlock sees parent===tip and work=parent.work+blockWork > tip.work. It is
  //     never a silent non-moving side branch.
  //   • Broadcast-first means an adopted block is PUBLIC (≥1 helper has it), so the worst
  //     case degrades from a *private* fork (the older adopt-first failure mode) to a
  //     *non-canonical public* fork — which the network can reorg. Reconciliation is the
  //     tip poller's hash-mismatch clause + the
  //     work-based catchUp (NOT this gate): a heavier sibling reorgs us out within 1–2 polls
  //     (reporter.reorg then de-counts the orphaned earning); an equal-work tie we contest by
  //     extending+rebroadcasting our own block (normal PoW). A sustained fork would need the
  //     read helper itself permanently isolated — the root trust assumption, out of scope.
  //   • REJECTED alt: "require helper /tip === ourBlock before adopting" — a helper's /tip
  //     lags a just-submitted block (it may store it as a side branch first), so this would
  //     routinely DROP our own valid solo block → re-mine the height → a worse competing fork
  //     + wasted (rare) solve. Strictly worse for safety and funds than accept===stored.
  let adopted = false;
  let localError: string | null = null;
  if (helperAccepted) {
    localError = await deps.chain.addBlock(block); // the consensus state transition (unchanged)
    adopted = localError === null;
  }
  return { block, statuses, helperAccepted, attempts, adopted, localError };
}
