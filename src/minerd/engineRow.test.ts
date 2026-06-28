// src/minerd/engineRow.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineRowValue } from './selectors.js';

test('engineRowValue: native shows "(faster)" when the toolchain is available', () => {
  assert.equal(engineRowValue('native', true), 'native  (faster)');
});

test('engineRowValue: native shows "(needs Rust)" when it cannot run', () => {
  assert.equal(engineRowValue('native', false), 'native  (needs Rust)');
});

test('engineRowValue: wasm reads "(portable)" regardless of native availability', () => {
  assert.equal(engineRowValue('wasm', true), 'wasm  (portable)');
  assert.equal(engineRowValue('wasm', false), 'wasm  (portable)');
});
