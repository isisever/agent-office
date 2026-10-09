cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.4.0"
  sha256 arm:   "c4f59fc69b65fb6da9260cf0669628d7f9bff995f47b5c53a412d38b722c0b37",
         intel: "6d12d89ea65af810e479dd415156a9ba39992b303c27e64ebaf25d8780a0dbd8"

  url "https://github.com/isisever/agent-office/releases/download/v#{version}/AgentOffice-#{version}-#{arch}.dmg"
  name "Agent Office"
  desc "Pixel-art office for Claude Code agents, with a terminal per project"
  homepage "https://github.com/isisever/agent-office"

  livecheck do
    url :url
    strategy :github_latest
  end

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
