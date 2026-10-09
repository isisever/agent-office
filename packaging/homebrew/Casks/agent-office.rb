cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.3.0"
  sha256 arm:   "034562db1f0dc5b755a1c6ac12517e821c899c2481458d0df24d48fede033687",
         intel: "76e7cceed156d5447e179e466ebb3922215e841a7a9105a9ced83e3e81e06d64"

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

    The app is not notarized by Apple yet. If macOS blocks the first launch, open
    System Settings → Privacy & Security and click "Open Anyway", or run:
      xattr -dr com.apple.quarantine "#{appdir}/Agent Office.app"
  EOS
end
