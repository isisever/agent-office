cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.15"
  sha256 arm:   "16db9e150e3f5250b460ccf1962a1fb31f605ed2d27c3a0551b38f9bc60a6fed",
         intel: "d5f5589d0b3c0ac5c62829a11922638cad83bb7781a53ffded4ccdbbafa6c75b"

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
