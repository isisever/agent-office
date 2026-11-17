cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.31"
  sha256 arm:   "a957f6d8e939b7e8f01834d30baa9164b7d9feb0f4ea4d594565bb20552f95ac",
         intel: "1789a5dc25eed0d98a339641f5a232ff2e3365b9254630cbae0eb5d7d04f1c3d"

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
