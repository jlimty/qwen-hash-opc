import readline from 'node:readline';
import { Writable } from 'node:stream';

export function askHidden(question) {
  process.stdout.write(question);
  const rl = readline.createInterface({ input: process.stdin, output: new Writable({ write(chunk, encoding, done) { done(); } }), terminal: true });
  return new Promise((done) => rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); done(answer); }));
}

export async function chooseNewPassword(ask = askHidden, label = 'password') {
  const first = await ask(`Choose the ${label} (12+ characters, not shown): `);
  if (first.length < 12) throw new Error('Use a password of at least 12 characters.');
  const second = await ask('Type it again to confirm: ');
  if (first !== second) throw new Error('The two entries did not match. Nothing was changed.');
  return first;
}
