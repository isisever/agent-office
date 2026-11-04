cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.19"
  sha256 arm:   "4e674a021f80f0a16c40f6285ab474ddcb8b03e8db48ceacddc378e8eb9c7010",
         intel: "28d018437420b1d1bbe5d6cbd01a485685af02e88ed73a2bc014c4317b52b4d3"

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
