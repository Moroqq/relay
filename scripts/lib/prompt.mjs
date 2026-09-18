/**
 * Terminal prompts for the key scripts. Hidden input shows nothing as you
 * type — not even asterisks, which would give away the length.
 */
import readline from 'node:readline';

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

export function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped in (a script, a secrets manager): read one line, echo nothing.
    const rl = readline.createInterface({ input: stdin });
    return new Promise((resolve) => {
      let got = false;
      rl.once('line', (line) => { got = true; rl.close(); resolve(line); });
      rl.once('close', () => { if (!got) resolve(''); });
    });
  }

  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
