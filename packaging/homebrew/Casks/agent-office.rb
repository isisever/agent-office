cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.47"
  sha256 arm:   "7e9d0d9cdf003bede7e9190d49c61d6d5c86ad279770abc7909504ba1a5ebdf3",
         intel: "e0271d3de1871b9f8a9e7d573a3127828abdad8fbdf65e85af9828b80a58f957"

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
