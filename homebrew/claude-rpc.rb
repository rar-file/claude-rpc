# Homebrew formula for claude-rpc.
#
# This file is the source of truth. To publish it as a tap so users can run
#   brew install rar-file/claude-rpc/claude-rpc
# create a repo named `homebrew-claude-rpc` under the rar-file org and drop this
# file in as `Formula/claude-rpc.rb`. After every npm release, regenerate the
# url + sha256 with `node scripts/brew-formula.mjs` and commit it to that tap.
class ClaudeRpc < Formula
  desc "Discord Rich Presence for Claude Code — live model, project, tokens & lifetime stats"
  homepage "https://claude-rpc.com"
  url "https://registry.npmjs.org/claude-rpc/-/claude-rpc-1.1.0.tgz"
  sha256 "6cc27a9aab77bade210171b091922de2b1228f901c2a8eb6d097ae061086fe1c"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-rpc --version")
  end
end
