cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.26"
  sha256 arm:   "d4e936d45b9046b3c3539ab0323015d117514f0dbab77d4d2c60bc4cad4a2b61",
         intel: "ccc1a98cb3cc71f2d9a0be99c7dd2aeda197968546e7fe2091e1c20c77d30183"

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
