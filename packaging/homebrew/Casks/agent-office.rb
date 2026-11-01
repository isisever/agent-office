cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.12"
  sha256 arm:   "87497c9e3fb9a0a3ae0e4162d7ffb87060844ee6933e08f9d903cfb9ccfc976a",
         intel: "da4d162320de8eebd04ce3ad922ad3b59f9b3cfbe8ba282fb043d9929ebb8eb6"

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
