'use strict';
const DEFAULT_RPC_PORT = 47474;

module.exports = function resolveRpcPort() {
  return parseInt(process.env.CLAUDE_RPC_PORT, 10) || DEFAULT_RPC_PORT;
};
