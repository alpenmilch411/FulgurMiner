// src/minerd/template.ts
import type { Blockchain } from '../chain/blockchain.js';
import { encodeHeader, computeTxRoot, type BlockHeader } from '../chain/block.js';
import { medianTimePast } from '../chain/consensus.js';
import { applyBlockTxs, cloneState, stateRoot, type State } from '../chain/state.js';
import { scriptsActiveForMtp } from '../chain/fork.js';
import { MTP_WINDOW } from '../chain/genesis.js';
import { compactToTarget } from '../util/binary.js';

export interface Template {
  header: BlockHeader;       // nonce = 0; the grinder mutates it
  headerBytes: Uint8Array;   // encodeHeader(header)
  targetHex: string;         // 64-hex target the hash must beat
  postState: State;          // state after the coinbase, for fast local addBlock on a win
}

/** Build an empty-block candidate header crediting `minerPubkey`, off the current tip. */
export function buildTemplate(chain: Blockchain, minerPubkey: Uint8Array): Template {
  const parent = chain.tip;
  const height = parent.block.header.height + 1;
  const now = Math.floor(Date.now() / 1000);
  const mtp = medianTimePast(chain.getRecentHeaders(MTP_WINDOW));
  const timestamp = Math.max(now, mtp + 1); // strictly above MTP; honest clock otherwise

  // Fork #3: delegate to the chain so the fork-#3 anchor (block 35,550's real
  // header) is fed in the same way the validator (addBlockInternal) does — a
  // bare nextDifficulty() would omit it and throw above SANDGLASS2_ANCHOR_HEIGHT.
  const difficulty = chain.expectedNextDifficulty(timestamp);

  const txRoot = computeTxRoot([]);
  const postState = cloneState(chain.tipState);
  // 5-arg: script ctx matches what the validator (addBlockInternal) uses for this
  // height's parent mtp. Solo builds empty blocks, so ctx is inert here (no txs to
  // gate) — passed for exactness/future-proofing, computed from the same tip mtp.
  applyBlockTxs(postState, height, minerPubkey, [], { scriptsActive: scriptsActiveForMtp(mtp), blockMtp: mtp }); // credits blockReward(height)
  const root = stateRoot(postState);

  const header: BlockHeader = {
    height,
    prevHash: parent.hash,
    txRoot,
    stateRoot: root,
    timestamp,
    difficulty,
    nonce: 0,
    miner: minerPubkey,
  };

  const targetHex = compactToTarget(difficulty).toString(16).padStart(64, '0');
  return { header, headerBytes: encodeHeader(header), targetHex, postState };
}
