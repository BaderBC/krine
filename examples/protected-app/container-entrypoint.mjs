import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';

// Compose preserves Linux host secret ownership. Read only the two required
// credentials, initialize the private volume, then permanently drop privileges.
process.umask(0o077);
if (process.getuid() !== 0) throw new Error('The container entrypoint requires startup root.');
for (const [file, name] of [['browser_public_key', 'KRINE_PUBLIC_KEY'], ['server_secret', 'KRINE_SECRET_KEY']]) {
  const value = readFileSync(`/run/secrets/${file}`, 'utf8').trim();
  if (!/^[\x21-\x7e]{24,4096}$/.test(value)) throw new Error(`Invalid secret file: ${file}`);
  process.env[name] = value;
  delete process.env[`${name}_FILE`];
}
const directory = '/var/lib/draftroom';
if (process.env.DEMO_DATA_DIR !== directory) throw new Error('Use the private mounted data directory.');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const stat = lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe data directory.');
if (stat.uid === 0 && readdirSync(directory).length === 0) {
  chmodSync(directory, 0o700);
  chownSync(directory, 10001, 10001);
} else if (stat.uid !== 10001 || stat.gid !== 10001 || (stat.mode & 0o777) !== 0o700) {
  throw new Error('Existing data directory must be private and owned by UID/GID 10001.');
}
process.setgroups([]);
process.setgid(10001);
process.setuid(10001);
await import('./dist/server/main.js');
