cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.22.5"
  sha256 arm:   "2daff0daf6704c26756bf2a977b8510f51f4826c24c97d30d2bf4b04aa3ef7b9",
         intel: "155bfa5b3fcb3a224a93653a7417bb5413022b08bd8bfc2a6f8a7b1ced34cfff"

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
