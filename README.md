# @sacred/cli

CLI to test deposits and claims on SacredEscrow without the UI.

This tool lets you:
- deposit funds for an identity (platform, userId)
- create and verify EIP-712 claim attestations
- relay claim transactions
- read deposit state
- refund after the window

## Setup

1. **Copy environment file:**
```bash
cp .env.example .env
```

2. **Edit .env file with your configuration:**
```bash
# Required: JSON-RPC endpoint for blockchain interaction
RPC_URL=https://testnet-passet-hub-eth-rpc.polkadot.io

# Required: Deployed SacredEscrow contract address
ESCROW_ADDRESS=0x4ed8F631E73A1e4aCf535894E11B033aba4936D5

# Required: Private keys for operations
RELAYER_PRIVATE_KEY=your_private_key_here
ATTESTER_PRIVATE_KEY=your_attester_private_key_here
```

3. **Install dependencies:**
```bash
npm install
```

## Usage

The CLI automatically loads configuration from `.env` file, making commands clean and simple:

```bash
# Show help
npm run dev -- --help

# Basic deposit (uses .env for all connection details)
npm run dev -- deposit --platform 1 --recipient-user-id 123456789 --amount 0.01

# Enhanced deposit with optional fields
npm run dev -- deposit --platform 1 --recipient-user-id 123456789 --amount 0.1 \
  --depositor-user-id 987654321 \
  --content-url "https://twitter.com/user/status/1234567890123456789"
```

You can also run directly with node:

```bash
# Show help
node src/index.js --help

# Run commands (uses .env file automatically)
node src/index.js deposit --platform 1 --recipient-user-id 123456789 --amount 0.01
```

## Environment

Configuration is loaded from the `.env` file in the CLI directory. You can also override values via command line flags:

**Environment Variables:**
- `RPC_URL`: JSON-RPC endpoint (required)
- `CHAIN_ID`: optional; auto-detected if omitted  
- `ESCROW_ADDRESS`: deployed SacredEscrow address (required)
- `RELAYER_PRIVATE_KEY`: for deposit/refund operations
- `ATTESTER_PRIVATE_KEY`: for signing attestations

**Command Line Flags:**
- `--depositor-key`: Private key for deposits/refunds
- `--relayer-key`: Private key for relaying transactions  
- `--attester-key`: Private key for signing attestations

Keys can be with or without 0x prefix.

## Global flags

- `--rpc` RPC URL (defaults to env RPC_URL)
- `--escrow` Escrow contract address (defaults to env ESCROW_ADDRESS)
- `--chain-id` Chain ID override (otherwise read from RPC)
- `--depositor-key` Private key to fund deposits / refunds
- `--relayer-key` Private key to submit claim tx (any key can submit, need native currency to pay gas)
- `--attester-key` Private key to sign EIP-712 attestations
- `--json` JSON output for scripts

## Typical flow

1) Deposit and note the returned `depositId`
2) Attest with attester key to produce a signature
3) (Optional) Verify signature offchain
4) Claim using relayer key + signature (or provide attester key to sign-and-claim)
5) Check status with get-deposit (claimed should be true)

## Optimized .env-based Commands

Since the CLI automatically loads from `.env`, you can run clean commands without specifying connection details:

```bash
# Complete flow using .env configuration
npm run dev -- deposit --platform 1 --recipient-user-id 123456789 --amount 0.01
# Note the depositId from output (e.g., depositId=35)

npm run dev -- get-deposit --deposit-id 1
# Verify deposit exists and claimed=false

npm run dev -- attest --platform 1 --user-id 123456789 --payout 0x1111111111111111111111111111111111111111 --deposit-id 1
# Creates EIP-712 signature

npm run dev -- claim --platform 1 --user-id 123456789 --payout 0x1111111111111111111111111111111111111111 --deposit-id 1 --nonce $(date +%s)000 --expiry $(($(date +%s) + 86400))
# Signs and submits claim transaction

npm run dev -- get-deposit --deposit-id 1
# Verify claimed=true
```

For JSON output (useful for scripts):
```bash
npm run dev -- get-deposit --deposit-id 1 --json
```

## Flag-based Commands

### deposit

Create a deposit for an identity. Returns tx hash and attempts to extract depositId from the DepositCreated event.

Args:
- `--platform` uint8 (1 = X/Twitter)
- `--recipient-user-id` uint256 numeric user id of the recipient
- `--amount` ETH amount (decimal; parsed with parseEther)
- `--depositor-user-id` uint256 (optional, defaults to 0) numeric user id of the depositor
- `--content-url` string (optional, defaults to "") URL of the content being tipped (e.g., Twitter post URL)

The new deposit function always includes all parameters (platformId, recipientUserId, depositorUserId, contentUri) for consistent behavior with the updated contract.

Example (basic deposit):
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  --depositor-key $DEPOSITOR_PK \
  deposit \
  --platform 1 \
  --recipient-user-id 987654321 \
  --amount 0.1
```

Example (enhanced deposit with optional fields):
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  --depositor-key $DEPOSITOR_PK \
  deposit \
  --platform 1 \
  --recipient-user-id 987654321 \
  --amount 0.1 \
  --depositor-user-id 123456789 \
  --content-url "https://twitter.com/user/status/1234567890123456789"
```

### attest

Create an EIP-712 claim attestation signature (offchain). Uses attester key locally.

Args:
- `--platform` uint8
- `--user-id` uint256
- `--payout` address
- `--deposit-id` uint256
- `--nonce` uint256 (optional; defaults to nowSeconds()*1000 + random 0..999)
- `--expiry` seconds (optional; defaults to now + 24h)

Example:
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  --attester-key $ATTESTER_PK \
  attest \
  --platform 1 \
  --user-id 987654321 \
  --payout 0x1111111111111111111111111111111111111111 \
  --deposit-id 1
```

### verify

Verify an attestation signature offline.

Args: same as claim plus `--signature`, optional `--expected-attester`

Example:
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  verify \
  --platform 1 \
  --user-id 987654321 \
  --payout 0x1111111111111111111111111111111111111111 \
  --deposit-id 1 \
  --nonce 42 \
  --expiry 1724000000 \
  --signature 0x...
```

### claim

Submit on-chain claim. If `--signature` is omitted and `--attester-key` is provided, it will sign locally before relaying. Performs offline verifyTypedData preflight before sending.

Args:
- `--platform` uint8
- `--user-id` uint256
- `--payout` address
- `--deposit-id` uint256
- `--nonce` uint256
- `--expiry` seconds
- `--signature` hex (optional, otherwise sign with `--attester-key`)

Example:
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  --relayer-key $RELAYER_PK \
  --attester-key $ATTESTER_PK \
  claim \
  --platform 1 \
  --user-id 987654321 \
  --payout 0x1111111111111111111111111111111111111111 \
  --deposit-id 1 \
  --nonce 42 \
  --expiry 1724000000
```

### get-deposit

Read deposit state.

Args:
- `--deposit-id` uint256

Example:
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  get-deposit \
  --deposit-id 1
```

### refund

Refund after the window (caller must be the original depositor).

Args:
- `--deposit-id` uint256

Example:
```bash
node src/index.js \
  --rpc $RPC_URL \
  --escrow $ESCROW_ADDRESS \
  --depositor-key $DEPOSITOR_PK \
  refund \
  --deposit-id 1
```


