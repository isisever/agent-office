// Homebrew cask'ını app/release'teki dmg'lerden yazar: node packaging/homebrew/update-cask.mjs
// Sürüm app/package.json'dan, sha256'lar AgentOffice-<sürüm>-{arm64,x64}.dmg dosyalarından gelir.
// Çıktı: packaging/homebrew/Casks/agent-office.rb (tap deposuna aynen kopyalanır).
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const { version } = JSON.parse(readFileSync(join(root, 'app', 'package.json'), 'utf8'))
// dmg klasörü: ilk argüman (ör. app/release-signed), yoksa app/release
const dir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'app', 'release')
const sha = arch => createHash('sha256').update(readFileSync(join(dir, `AgentOffice-${version}-${arch}.dmg`))).digest('hex')

const cask = `cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha('arm64')}",
         intel: "${sha('x64')}"

  url "https://github.com/isisever/agent-office/releases/download/v#{version}/AgentOffice-#{version}-#{arch}.dmg"
  name "Agent Office"
  desc "Pixel-art office for Claude Code agents, with a terminal per project"
  homepage "https://github.com/isisever/agent-office"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Agent Office.app"

  zap trash: [
    "~/.claude/agent-office",
    "~/Library/Application Support/Agent Office",
    "~/Library/Preferences/io.github.isisever.agentoffice.plist",
    "~/Library/Saved Application State/io.github.isisever.agentoffice.savedState",
  ]

  caveats <<~EOS
    Agent Office runs the Claude Code CLI; install it first if needed:
      https://code.claude.com

  EOS
end
`
const out = join(here, 'Casks', 'agent-office.rb')
writeFileSync(out, cask)
console.log(`${out} → ${version}`)
