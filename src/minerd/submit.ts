// src/minerd/submit.ts
import type { Block } from '../chain/block.js';
import type { Template } from './template.js';
import type { SubmitResult } from './http.js';

export interface SubmitDeps {
  chain: { addBlock(block: Block): Promise<string | null> };
  helpers: string[];
  postBlock: (base: string, block: Block) => Promise<SubmitResult>;
}

export interface SubmitOutcome {
  block: Block;
  localError: string | null;
  statuses: string[];
}

/** Assemble the winning block, apply it locally, and broadcast to all helpers. */
export async function submitSolution(deps: SubmitDeps, template: Template, nonce: number): Promise<SubmitOutcome> {
  const block: Block = { header: { ...template.header, nonce }, transactions: [] };

  // Advance our own state immediately (don't wait on the network round-trip).
  const localError = await deps.chain.addBlock(block);

  const results = await Promise.allSettled(deps.helpers.map((h) => deps.postBlock(h, block)));
  const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : `error:${(r.reason as Error).message}`));

  return { block, localError, statuses };
}
