/**
 * Compile the contracts under test, including the mocks.
 *
 * Kept separate from compile.mjs so test doubles can never end up in the
 * artifact that gets deployed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const here = path.dirname(fileURLToPath(import.meta.url));

const sources = {
  'RelayCollector.sol': { content: fs.readFileSync(path.join(here, 'src', 'RelayCollector.sol'), 'utf8') },
  'Mocks.sol': { content: fs.readFileSync(path.join(here, 'test', 'Mocks.sol'), 'utf8') },
};

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources,
      settings: {
        evmVersion: 'istanbul',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    }),
  ),
);

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  throw new Error('compilation failed');
}

/** name -> { abi, bytecode } for every contract in every file. */
export const contracts = {};
for (const file of Object.keys(output.contracts)) {
  for (const [name, c] of Object.entries(output.contracts[file])) {
    contracts[name] = { abi: c.abi, bytecode: c.evm.bytecode.object };
  }
}
