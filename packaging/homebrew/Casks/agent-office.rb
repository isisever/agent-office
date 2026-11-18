cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.33"
  sha256 arm:   "287f10b18478dd7b63b739e34852f236968876eecd97dda8b39ea03b9f8af945",
         intel: "6996d15059f7fdbca59b7c13067ee1ef97541fcc3ea333087988d53dc6bbfa68"

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
