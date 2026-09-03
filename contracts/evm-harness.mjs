/**
 * A minimal EVM harness for testing the collector without a chain.
 *
 * TRON's virtual machine is EVM-compatible for everything this contract does —
 * storage, calls, reverts, return data — so running the same compiled bytecode
 * here exercises the real logic. It does not cover TRON-specific behaviour
 * (energy accounting, the resource model), which is why the compile step also
 * refuses opcodes TRON cannot execute.
 */
import { createEVM } from '@ethereumjs/evm';
import { Address, hexToBytes, bytesToHex, createAddressFromString } from '@ethereumjs/util';

import { contracts } from './compile-test.mjs';

const GAS = 30_000_000n;

export const addr = (hex) => createAddressFromString(hex);

/** 20-byte address from a short label, so test output is readable. */
export function namedAddress(label) {
  const hex = Buffer.from(label.padEnd(20, '.')).toString('hex').slice(0, 40);
  return createAddressFromString('0x' + hex);
}

export async function newEvm() {
  return createEVM();
}

// --- the sliver of ABI encoding these tests need ------------------------------

const pad = (value) => value.toString(16).padStart(64, '0');
const padAddress = (a) => a.toString().replace(/^0x/, '').padStart(64, '0');

export function encodeCall(selectorHex, args) {
  let head = '';
  let tail = '';
  const headWords = args.length;

  for (const arg of args) {
    if (Array.isArray(arg)) {
      // Dynamic: head holds the offset, tail holds length then elements.
      head += pad(BigInt(headWords * 32 + tail.length / 2));
      tail += pad(BigInt(arg.length)) + arg.map((a) => padAddress(a)).join('');
    } else if (typeof arg === 'bigint') {
      head += pad(arg);
    } else if (typeof arg === 'boolean') {
      head += pad(arg ? 1n : 0n);
    } else {
      head += padAddress(arg);
    }
  }

  return hexToBytes('0x' + selectorHex + head + tail);
}

/** keccak of the signature, first four bytes — precomputed per call site. */
export async function selector(signature) {
  const { keccak_256 } = await import('@noble/hashes/sha3.js');
  const { bytesToHex: toHex, utf8ToBytes } = await import('@noble/hashes/utils.js');
  return toHex(keccak_256(utf8ToBytes(signature)).subarray(0, 4));
}

// --- deploying and calling ----------------------------------------------------

export async function deploy(evm, name, constructorArgs = []) {
  const artifact = contracts[name];
  if (artifact === undefined) throw new Error(`No compiled contract named ${name}`);

  const encodedArgs = constructorArgs.map((a) =>
    typeof a === 'bigint' ? pad(a) : padAddress(a),
  ).join('');

  const result = await evm.runCall({
    caller: namedAddress('deployer'),
    to: undefined,
    data: hexToBytes('0x' + artifact.bytecode + encodedArgs),
    gasLimit: GAS,
  });

  if (result.execResult.exceptionError !== undefined) {
    throw new Error(`deploy ${name} failed: ${result.execResult.exceptionError.error}`);
  }
  if (result.createdAddress === undefined) throw new Error(`deploy ${name} produced no address`);

  return result.createdAddress;
}

export async function call(evm, { from, to, signature, args = [] }) {
  const result = await evm.runCall({
    caller: from,
    to,
    data: encodeCall(await selector(signature), args),
    gasLimit: GAS,
  });

  const execResult = result.execResult;
  return {
    reverted: execResult.exceptionError !== undefined,
    error: execResult.exceptionError?.error,
    returnValue: bytesToHex(execResult.returnValue),
    gasUsed: execResult.executionGasUsed,
  };
}

/** Read a uint256 out of return data. */
export function asUint(hex) {
  const clean = hex.replace(/^0x/, '');
  return clean === '' ? 0n : BigInt('0x' + clean.slice(0, 64));
}

export { Address, hexToBytes, bytesToHex };
