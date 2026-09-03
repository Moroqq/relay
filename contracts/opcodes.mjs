/**
 * Checking compiled bytecode for opcodes TRON cannot execute.
 *
 * Searching the hex for a byte value would not do: a PUSH instruction carries
 * its operand inline, so any byte pattern appears constantly inside data that
 * is never executed. The only honest way to know whether an opcode is present
 * is to step through the stream, skipping each PUSH's operand.
 */

/**
 * PUSH0 (0x5f) arrived with the Shanghai EVM and solc 0.8.20. TRON's virtual
 * machine does not implement it: a contract containing it deploys
 * successfully and then reverts on every call, with nothing in the failure
 * that points at the cause.
 */
export const FORBIDDEN_OPCODES = new Map([[0x5f, 'PUSH0']]);

/** Opcodes present in the executable stream, ignoring PUSH operands. */
export function findForbiddenOpcodes(hex) {
  const clean = hex.replace(/^0x/, '').toLowerCase();
  const found = new Set();

  for (let i = 0; i < clean.length; i += 2) {
    const op = Number.parseInt(clean.slice(i, i + 2), 16);
    if (Number.isNaN(op)) break;

    const name = FORBIDDEN_OPCODES.get(op);
    if (name !== undefined) found.add(name);

    // PUSH1..PUSH32 are 0x60..0x7f and carry 1..32 bytes of operand.
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
  }

  return [...found];
}
