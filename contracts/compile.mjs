/**
 * Compile the collector contract.
 *
 * Two settings are load-bearing rather than taste.
 *
 * The compiler is pinned to 0.8.19. From 0.8.20 solc targets the Shanghai EVM
 * by default and emits the PUSH0 opcode, which TRON's virtual machine does not
 * implement — the contract deploys and then reverts on every call, with no
 * error that points at the cause.
 *
 * `evmVersion` is set to istanbul for the same reason, one layer down: it
 * keeps the compiler away from opcodes introduced after TRON forked its VM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

import { findForbiddenOpcodes } from './opcodes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'src', 'RelayCollector.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'RelayCollector.sol': { content: source } },
  settings: {
    evmVersion: 'istanbul',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
const warnings = (output.errors ?? []).filter((e) => e.severity === 'warning');

for (const warning of warnings) console.warn('  warning:', warning.formattedMessage.trim());
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

const contract = output.contracts['RelayCollector.sol']['RelayCollector'];
const bytecode = contract.evm.bytecode.object;

// The check lives in opcodes.mjs, where it is unit tested: a naive search of
// the hex would flag every PUSH operand that happens to be 0x5f and block
// perfectly good builds.
for (const [label, code] of [
  ['constructor', bytecode],
  ['runtime', contract.evm.deployedBytecode.object],
]) {
  const forbidden = findForbiddenOpcodes(code);
  if (forbidden.length > 0) {
    console.error(
      `  ${label} bytecode contains ${forbidden.join(", ")} - TRON cannot execute it.` +
        `\n  Compile with solc 0.8.19 or older, or target an earlier evmVersion.`,
    );
    process.exit(1);
  }
}
console.log('  no TRON-incompatible opcodes');

const artifact = {
  contractName: 'RelayCollector',
  compiler: `solc ${solc.version()}`,
  evmVersion: input.settings.evmVersion,
  abi: contract.abi,
  bytecode,
  deployedBytecode: contract.evm.deployedBytecode.object,
};

const outDir = path.join(here, 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'RelayCollector.json'), JSON.stringify(artifact, null, 2) + '\n');

console.log(`  compiled with ${artifact.compiler} targeting ${artifact.evmVersion}`);
console.log(`  bytecode: ${bytecode.length / 2} bytes`);
console.log(`  abi: ${contract.abi.length} entries`);
