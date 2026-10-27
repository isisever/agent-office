cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.4"
  sha256 arm:   "477f2af38eb7abbb87950a25aba107c4b0a5aa28180a34b228b34529ba88b8cd",
         intel: "a421fbeca58f0234a9e8e907920fd5770d4d9d77e0b9d034f3ab5e83ebcaaed2"

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
