cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.10"
  sha256 arm:   "c97700f4d3a22f03cc78b596273075ea5fdc48f9a5df87ed22ec9a497a779a49",
         intel: "de5d78a97c3c8ca85b88941ec97f667f6f6f2c868b362ff03152cba776c2dcbb"

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
