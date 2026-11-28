cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.54"
  sha256 arm:   "76f13ea600aca8aa507cc1c1c81dfdfea87cf09db8a33e3145a7ad72e76ca90f",
         intel: "4ebd4e06cd347d6708768c6fafa0cba7d53dd480845ee24f8216eaae0d788819"

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
