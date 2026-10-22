// electron-builder config for the Windows installer: package.json's "build", except which node-pty prebuilds ship.
// package.json leaves out every win32 prebuild (macOS and Linux must not carry them, and electron-builder copies
// node_modules with exclusion patterns only, so a platform's "files" cannot add them back). Here win32-x64 stays
// (pty.node, conpty.node, conpty/conpty.dll, OpenConsole.exe, winpty) and the macOS and arm64 ones go.
// npm run dist:win → electron-builder --win --config scripts/win-builder-config.cjs
const { build } = require('../package.json');

const NO_WIN32 = '!node_modules/node-pty/prebuilds/win32-*/**';
// udx-native and sodium-native (the device link): package.json ships only their darwin prebuilds; here win32-x64 only
const LINK_MAC = '!node_modules/{udx-native,sodium-native}/prebuilds/{android,ios,linux,win32}-*/**';
const LINK_WIN = '!node_modules/{udx-native,sodium-native}/prebuilds/{android,ios,linux,darwin,win32-arm64}*/**';
const WIN_ONLY = [
  '!node_modules/node-pty/prebuilds/darwin-*/**',
  '!node_modules/node-pty/prebuilds/win32-arm64/**',
  '!node_modules/node-pty/prebuilds/win32-x64/*.pdb',
];

for (const p of [NO_WIN32, LINK_MAC]) if (!build.files.includes(p)) throw new Error(`package.json build.files no longer has ${p}`);

// Code signing is opt-in by environment at build time, and no secret lives in this file (it stays in the release
// workflow's secrets):
// - a CSC_LINK (the path or URL of a .pfx) with CSC_KEY_PASSWORD: electron-builder reads those env names itself and
//   signs through signtool, so this config needs nothing;
// - Azure Trusted Signing (https://aka.ms/trustedsigning): when all four identifiers below are in the environment
//   (plus the Entra credentials the sign manager reads, AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET),
//   win gains azureSignOptions and the signing goes over the Trusted Signing service;
// - GitHub Actions makes an undefined secret empty (''), and electron-builder would then try to sign with an empty
//   link or a half-set Trusted Signing account — so empty signing envs are dropped here;
// - with nothing set, the build stays unsigned exactly as it is today (SmartScreen stops it; see README → Windows).
const AZURE_ENV = {
  publisherName: 'AZURE_SIGNING_PUBLISHER_NAME',
  endpoint: 'AZURE_SIGNING_ENDPOINT',
  certificateProfileName: 'AZURE_SIGNING_PROFILE',
  codeSigningAccountName: 'AZURE_SIGNING_ACCOUNT',
};
const SIGNING_ENVS = ['CSC_LINK', 'CSC_KEY_PASSWORD', ...Object.values(AZURE_ENV), 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];
for (const name of SIGNING_ENVS) if (process.env[name] === '') delete process.env[name];
// read after the empty ones are gone
const AZURE = Object.fromEntries(Object.entries(AZURE_ENV).map(([field, name]) => [field, process.env[name]]));
const azureSet = Object.values(AZURE).filter(Boolean);
if (azureSet.length && azureSet.length < 4) {
  throw new Error('Azure Trusted Signing needs its four envs together: AZURE_SIGNING_PUBLISHER_NAME, AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_PROFILE, AZURE_SIGNING_ACCOUNT');
}

module.exports = {
  ...build,
  ...(azureSet.length === 4 ? { win: { ...build.win, azureSignOptions: AZURE } } : {}),
  files: [...build.files.filter((f) => f !== NO_WIN32 && f !== LINK_MAC), ...WIN_ONLY, LINK_WIN],
};
