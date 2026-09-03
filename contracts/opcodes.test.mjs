import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { findForbiddenOpcodes } from './opcodes.mjs';

test('PUSH0 in the executable stream is found', () => {
  // 5f = PUSH0, then STOP.
  assert.deepEqual(findForbiddenOpcodes('5f00'), ['PUSH0']);
});

test('the same byte as a PUSH operand is not a false alarm', () => {
  // 60 5f = PUSH1 0x5f. The 5f is data being pushed, never executed.
  // A naive search of the hex string would flag this and block a good build.
  assert.deepEqual(findForbiddenOpcodes('605f00'), []);

  // PUSH32 followed by 32 bytes of 5f, then STOP.
  assert.deepEqual(findForbiddenOpcodes('7f' + '5f'.repeat(32) + '00'), []);
});

test('an opcode after a skipped operand is still seen', () => {
  // PUSH1 0xff, then PUSH0.
  assert.deepEqual(findForbiddenOpcodes('60ff5f'), ['PUSH0']);
});

test('ordinary bytecode is clean', () => {
  assert.deepEqual(findForbiddenOpcodes('6080604052348015600f57600080fd5b00'), []);
  assert.deepEqual(findForbiddenOpcodes(''), []);
});

test('the shipped artifact is free of them', () => {
  const artifact = JSON.parse(
    fs.readFileSync(new URL('./build/RelayCollector.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(findForbiddenOpcodes(artifact.bytecode), []);
  assert.deepEqual(findForbiddenOpcodes(artifact.deployedBytecode), []);
});
