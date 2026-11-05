cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.21"
  sha256 arm:   "7a2b1ad117d8e67a9dbc43e329b2762474fe2e4ec2b6978ce25175b47604dc4b",
         intel: "658e5073a5ffda2a705ab376c6bd958e8df61b898ab6e91447de3852d02ee6e8"

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
