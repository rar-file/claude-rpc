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
  url "https://registry.npmjs.org/claude-rpc/-/claude-rpc-1.4.0.tgz"
  sha256 "735ed9ed79b836c46fe57e1cd4266b5231f80485be67e4baa057017914a89e1f"
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
