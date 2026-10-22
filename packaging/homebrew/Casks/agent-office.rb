cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.17.0"
  sha256 arm:   "857ae7d84744c292f0dcdbbfa2a96522f767e3ce0339e4d006a8260c3a50edbb",
         intel: "9d84c69547f092d264ddb22aaa6bf5012285dfbb0ae2c7ce33a57985a57025ee"

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
