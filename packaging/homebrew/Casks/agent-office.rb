cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.51"
  sha256 arm:   "4d19f94bef742fbbb9c807dc0dcf597116b232f069c05854d3e4e308a78e74b9",
         intel: "25db2eb6ebb031f88cf21f3ea7ecbfcc9063ade7a868d40a43d78d3fcccc8b21"

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
