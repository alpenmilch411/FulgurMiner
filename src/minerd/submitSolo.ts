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
  /** True once the block was adopted into the local chain (only after helperAccepted). */
  adopted: boolean;
  /** chain.addBlock error if adoption was attempted and failed; null otherwise. */
  localError: string | null;
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
export async function submitSoloBlock(deps: SubmitSoloDeps, template: Template, nonce: number): Promise<SubmitSoloOutcome> {
  // Byte-identical block assembly to the old path (header + nonce, no txs).
  const block: Block = { header: { ...template.header, nonce }, transactions: [] };

  // Broadcast FIRST — only adopt once the network confirms it has the block.
  const results = await Promise.allSettled(deps.helpers.map((h) => deps.postBlock(h, block)));
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : `error:${(r.reason as Error).message}`));
  const helperAccepted = statuses.some(isHelperAccept);

  let adopted = false;
  let localError: string | null = null;
  if (helperAccepted) {
    localError = await deps.chain.addBlock(block); // the consensus state transition (unchanged)
    adopted = localError === null;
  }
  return { block, statuses, helperAccepted, adopted, localError };
}
