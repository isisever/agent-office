cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.34"
  sha256 arm:   "f24c1182de3b2fbea08a00744e0a36ce43f468fa88023f2d9ad6de30ad047b73",
         intel: "77023422da7ccc1a518cc0fb66a8b4ba2b3a2eecf2c88482f430f0c0bed75afd"

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
