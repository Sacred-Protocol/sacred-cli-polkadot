/**
 * Simple config loader for environment variables
 */
export function loadConfig(env = process.env) {
  return {
    RPC_URL: env.RPC_URL,
    CHAIN_ID: env.CHAIN_ID ? Number(env.CHAIN_ID) : undefined,
    ESCROW_ADDRESS: env.ESCROW_ADDRESS,
    FEE_BPS: env.FEE_BPS ? Number(env.FEE_BPS) : 100,
    FEE_RECIPIENT: env.FEE_RECIPIENT,
    ATTESTER_PRIVATE_KEY: env.ATTESTER_PRIVATE_KEY,
    RELAYER_PRIVATE_KEY: env.RELAYER_PRIVATE_KEY,
    CORS_ORIGIN: env.CORS_ORIGIN || "*",
    RATE_LIMIT: env.RATE_LIMIT ? Number(env.RATE_LIMIT) : 60,
    TWITTER_CLIENT_ID: env.TWITTER_CLIENT_ID,
    TWITTER_CLIENT_SECRET: env.TWITTER_CLIENT_SECRET,
    OAUTH_REDIRECT_URL: env.OAUTH_REDIRECT_URL,
    chainId: env.CHAIN_ID ? Number(env.CHAIN_ID) : undefined
  };
}
