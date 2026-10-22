// electron-builder beforePack hook (package.json build.beforePack; the Linux and Windows configs inherit it): every
// package gets node-pty built with the quit-crash define for the arch being packed (scripts/node-pty-patch.cjs),
// whatever the last npm install left behind. Strict: a failure here fails the build, so a release never ships the
// unpatched module. Windows: nothing to do (see node-pty-patch.cjs).
const path = require('node:path');
const NP = require('./node-pty-patch.cjs');

/** electron-builder's Arch enum (builder-util): ia32 = 0, x64 = 1, armv7l = 2, arm64 = 3, universal = 4 */
const ARCH = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/** @param {{ electronPlatformName: string, arch: number }} context */
module.exports = async function beforePack(context, { appDir = path.join(__dirname, '..'), ensure = NP.ensurePatched } = {}) {
  const platform = context.electronPlatformName;
  const arch = ARCH[context.arch];
  if (platform !== 'darwin' && platform !== 'linux') return;
  if (!arch || arch === 'universal') throw new Error(`node-pty patch: cannot pack ${platform} arch ${context.arch}`);
  ensure({ appDir, platform, arch });
  const ptyDir = path.join(appDir, 'node_modules', 'node-pty');
  if (!NP.isPatched(ptyDir, platform, arch)) throw new Error(`node-pty for ${platform}-${arch} is not built with ${NP.DEFINE}`);
};
