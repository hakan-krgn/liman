// electron-builder afterPack hook: npm ships node-pty's spawn-helper without the
// executable bit, and without it macOS can't start a local terminal.
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = `${context.packager.appInfo.productFilename}.app`
  const prebuilds = join(context.appOutDir, app, 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds')
  if (!existsSync(prebuilds)) throw new Error(`node-pty prebuilds missing at ${prebuilds}`)
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
