import { sha256 } from '../crypto/hash.js';
import { concat } from './binary.js';

/**
 * Compute a Merkle root by hashing pairs upward. Odd nodes are duplicated
 * (Bitcoin-style), which is a KNOWN CVE-2012-2459-class vector: a tree whose
 * last node is duplicated can collide with a different leaf multiset. This is
 * NOT mitigated by the header's length-prefixing (that bounds the encoded block
 * size, not the tree's internal second-preimage ambiguity) — the earlier comment
 * claiming so was wrong. We ACCEPT the vector because the merkle algorithm is a
 * network-wide consensus rule: domain-separating leaves vs internal nodes would
 * change every txRoot and hard-fork this node off the chain. The practical guard
 * is that a block's txRoot is recomputed from its decoded, fixed-length-bounded
 * transactions and re-verified on acceptance (blockchain.ts) — a forged
 * duplicate-leaf tree would still have to be an otherwise fully valid block.
 * To actually close it, coordinate a domain-separation fork with upstream.
 */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(32);
  if (leaves.length === 1) return sha256(leaves[0]!);

  let layer = leaves.map((l) => sha256(l));
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = i + 1 < layer.length ? layer[i + 1]! : layer[i]!;
      next.push(sha256(concat(left, right)));
    }
    layer = next;
  }
  return layer[0]!;
}
