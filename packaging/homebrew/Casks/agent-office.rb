cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.22"
  sha256 arm:   "94744afe8bf27fa6dd5aede3441f46c7839d68248dc7f9b0ec2021fb0b9a233f",
         intel: "09b1dd7271d7ae2a9e0ee665d1cab3830feab01bdc18b4e06bbb526d6ec1b749"

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
