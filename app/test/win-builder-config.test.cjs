// Behaviour of scripts/win-builder-config.cjs: empty signing envs (what GitHub Actions makes of an undefined
// secret) are dropped, and Azure Trusted Signing is configured only when all four names are set.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CONFIG = path.join(__dirname, '..', 'scripts', 'win-builder-config.cjs');
const NAMES = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'AZURE_SIGNING_PUBLISHER_NAME', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_PROFILE',
  'AZURE_SIGNING_ACCOUNT', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

// Loads the config in a fresh process with exactly `env` as the signing envs; returns { win, left } (left = signing env names still present).
function load(env) {
  const clean = { ...process.env };
  for (const n of NAMES) delete clean[n];
  const script = `try { const c = require(${JSON.stringify(CONFIG)});
    process.stdout.write(JSON.stringify({ win: c.win, left: ${JSON.stringify(NAMES)}.filter((n) => n in process.env) })); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...clean, ...env }, encoding: 'utf8' }));
}

test('win-builder-config: every empty signing env, Azure names included, is deleted', () => {
  const r = load(Object.fromEntries(NAMES.map((n) => [n, ''])));
  assert.deepStrictEqual(r.left, []);
  assert.strictEqual(r.win && r.win.azureSignOptions, undefined);
});

test('win-builder-config: set signing envs are left alone', () => {
  const r = load({ CSC_LINK: 'x.pfx', AZURE_TENANT_ID: 't', AZURE_SIGNING_PROFILE: '' });
  assert.ok(r.left.includes('CSC_LINK') && r.left.includes('AZURE_TENANT_ID'));
  assert.ok(!r.left.includes('AZURE_SIGNING_PROFILE'));
});

test('win-builder-config: a partial Azure set is an error', () => {
  const r = load({ AZURE_SIGNING_ENDPOINT: 'https://e', AZURE_SIGNING_PUBLISHER_NAME: 'P' });
  assert.match(r.error, /four envs together/);
});

test('win-builder-config: all four Azure names give azureSignOptions with the electron-builder field names', () => {
  const r = load({ AZURE_SIGNING_PUBLISHER_NAME: 'P', AZURE_SIGNING_ENDPOINT: 'https://e', AZURE_SIGNING_PROFILE: 'prof', AZURE_SIGNING_ACCOUNT: 'acc' });
  assert.deepStrictEqual(r.win.azureSignOptions, { publisherName: 'P', endpoint: 'https://e', certificateProfileName: 'prof', codeSigningAccountName: 'acc' });
});
