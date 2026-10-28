cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.6"
  sha256 arm:   "c433dedf84c3390f4da5715faa5eeb3130c0b41199dbc9b2e135366ad40bf458",
         intel: "bb380d1d3bb6ab5f2bcac2f46c11e2a889ef93b685a3dca2cb6b05a3c987df7d"

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
