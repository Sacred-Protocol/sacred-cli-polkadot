#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  parseEther,
  verifyTypedData
} from "ethers";
import { loadConfig } from "./config.js";
import { sacredEscrowAbi } from "./abi.js";

// Common utilities (inlined)
const EIP712Domain = {
  name: "SacredAttester",
  version: "1"
};

const ClaimAttestationTypes = {
  ClaimAttestation: [
    { name: "platformId", type: "uint8" },
    { name: "userId", type: "uint256" },
    { name: "payoutAddress", type: "address" },
    { name: "depositId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" }
  ]
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function toHexKey(k) {
  if (!k) return undefined;
  return k.startsWith("0x") ? k : "0x" + k;
}

function toBigIntLike(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") {
    if (v.startsWith("0x") || v.startsWith("0X")) return BigInt(v);
    return BigInt(v);
  }
  throw new Error(`Cannot convert to bigint: ${v}`);
}

async function getProvider(rpc) {
  const cfg = loadConfig(process.env);
  const rpcUrl = rpc ?? cfg.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required (flag --rpc or env)");
  return new JsonRpcProvider(rpcUrl);
}

async function resolveChainId(provider, chainId) {
  if (chainId !== undefined && String(chainId).trim().length) {
    const n = Number(chainId);
    if (!Number.isNaN(n)) return n;
  }
  const net = await provider.getNetwork();
  return Number(net.chainId);
}

function buildWallet(key, provider) {
  const k = toHexKey(key);
  if (!k) throw new Error("Invalid private key");
  return new Wallet(k, provider);
}

function buildDomain(chainId, verifyingContract) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(verifyingContract)) {
    throw new Error("ESCROW address must be a 0x-prefixed address");
  }
  return {
    name: EIP712Domain.name,
    version: EIP712Domain.version,
    chainId,
    verifyingContract
  };
}

function getEscrow(escrowAddr, providerOrSigner) {
  if (!escrowAddr) throw new Error("ESCROW_ADDRESS is required (flag --escrow or env)");
  return new Contract(escrowAddr, sacredEscrowAbi, providerOrSigner);
}

function logOut(obj, json, human) {
  if (json) {
    // Replace bigint with string for JSON safety
    const replacer = (_, value) => (typeof value === "bigint" ? value.toString() : value);
    process.stdout.write(JSON.stringify(obj, replacer, 2) + "\n");
  } else {
    if (human) console.log(human);
    else console.log(obj);
  }
}

const program = new Command();
program
  .name("sacred-escrow")
  .description("CLI to deposit/attest/claim/refund against SacredEscrow")
  .option("--rpc <url>", "RPC URL (falls back to env RPC_URL)")
  .option("--escrow <address>", "Escrow contract address (falls back to env ESCROW_ADDRESS)")
  .option("--chain-id <id>", "Chain ID override (otherwise read from RPC)")
  .option("--depositor-key <hex>", "Private key for depositor (no 0x or with 0x)")
  .option("--relayer-key <hex>", "Private key for relayer (no 0x or with 0x)")
  .option("--attester-key <hex>", "Private key for attester (no 0x or with 0x)")
  .option("--json", "JSON output", false);

// deposit
program
  .command("deposit")
  .description("Create a deposit for an identity")
  .requiredOption("--platform <uint8>", "Platform id (e.g., 1 for X/Twitter)")
  .requiredOption("--recipient-user-id <uint256>", "Platform numeric user id of the recipient")
  .requiredOption("--amount <eth>", "Amount in ETH to deposit (e.g., 0.1)")
  .option("--depositor-user-id <uint256>", "Optional: Platform numeric user id of the depositor", "0")
  .option("--content-url <string>", "Optional: URL of the content being tipped (e.g., Twitter post URL)", "")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const provider = await getProvider(rpc);
    const chainId = await resolveChainId(provider, g.chainId ?? cfg.chainId);
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;

    const depositorKey = g.depositorKey ?? cfg.RELAYER_PRIVATE_KEY; // fallback
    if (!depositorKey) throw new Error("depositor-key (or RELAYER_PRIVATE_KEY) required for deposit");

    const wallet = buildWallet(depositorKey, provider);
    const escrow = getEscrow(escrowAddr, wallet);

    const platformId = Number(opts.platform);
    const recipientUserId = toBigIntLike(opts.recipientUserId);
    const amountWei = parseEther(String(opts.amount));
    const depositorUserId = toBigIntLike(opts.depositorUserId || "0");
    const contentUri = String(opts.contentUrl || "");

    // Use the new deposit function signature
    const tx = await escrow.deposit(platformId, recipientUserId, depositorUserId, contentUri, { value: amountWei });
    const receipt = await tx.wait();

    // Try to parse DepositCreated event for depositId
    let depositId;
    let eventArgs = {};
    try {
      for (const log of receipt?.logs ?? []) {
        try {
          const parsed = escrow.interface.parseLog(log);
          if (parsed && parsed.name === "DepositCreated") {
            // New event structure: (depositId, depositorAddress, platformId, recipientUserId, amount, depositorUserId, contentUri)
            eventArgs = {
              depositId: (parsed.args?.depositId ?? parsed.args?.[0])?.toString(),
              depositorAddress: parsed.args?.depositorAddress ?? parsed.args?.[1],
              platformId: parsed.args?.platformId ?? parsed.args?.[2],
              recipientUserId: (parsed.args?.recipientUserId ?? parsed.args?.[3])?.toString(),
              amount: (parsed.args?.amount ?? parsed.args?.[4])?.toString(),
              depositorUserId: (parsed.args?.depositorUserId ?? parsed.args?.[5])?.toString(),
              contentUri: parsed.args?.contentUri ?? parsed.args?.[6]
            };
            depositId = eventArgs.depositId;
            break;
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const out = {
      chainId,
      escrow: escrowAddr,
      hash: tx.hash,
      depositId: depositId ?? null,
      ...eventArgs
    };
    
    const humanOutput = `Deposit submitted. tx=${tx.hash}${depositId ? ` depositId=${depositId}` : ""}${
      eventArgs.depositorUserId && eventArgs.depositorUserId !== "0" ? ` depositorUserId=${eventArgs.depositorUserId}` : ""
    }${
      eventArgs.contentUri ? ` contentUri="${eventArgs.contentUri}"` : ""
    }`;
    
    logOut(out, g.json, humanOutput);
  });

// attest (off-chain signature generation)
program
  .command("attest")
  .description("Create an EIP-712 claim attestation signature (off-chain)")
  .requiredOption("--platform <uint8>", "Platform id")
  .requiredOption("--user-id <uint256>", "Platform numeric user id")
  .requiredOption("--payout <address>", "Payout address")
  .requiredOption("--deposit-id <uint256>", "Deposit ID to claim")
  .option("--nonce <uint256>", "Nonce (defaults to nowSeconds()*1000 + rand)")
  .option("--expiry <seconds>", "Expiry unix seconds (defaults to now + 24h)")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;
    const provider = await getProvider(rpc);
    const chainId = await resolveChainId(provider, g.chainId ?? cfg.chainId);

    const attesterKey = g.attesterKey ?? cfg.ATTESTER_PRIVATE_KEY;
    if (!attesterKey) throw new Error("attester-key (or ATTESTER_PRIVATE_KEY) required for attest");

    const wallet = buildWallet(attesterKey, provider);

    const platformId = Number(opts.platform);
    const userId = toBigIntLike(opts.userId);
    const payoutAddress = String(opts.payout);
    const depositId = toBigIntLike(opts.depositId);
    const nonce = opts.nonce !== undefined ? toBigIntLike(opts.nonce) : BigInt(nowSeconds()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const expiry = opts.expiry !== undefined ? Number(opts.expiry) : nowSeconds() + 24 * 60 * 60;

    const domain = buildDomain(chainId, escrowAddr);
    const value = { platformId, userId, payoutAddress, depositId, nonce, expiry };

    const signature = await wallet.signTypedData(domain, ClaimAttestationTypes, value);

    const out = { domain, types: ClaimAttestationTypes, value, signature, attester: wallet.address };
    logOut(out, g.json, `Signature: ${signature}`);
  });

// verify (off-chain signature verification)
program
  .command("verify")
  .description("Verify a claim attestation signature off-chain (no blockchain interaction)")
  .requiredOption("--platform <uint8>", "Platform id")
  .requiredOption("--user-id <uint256>", "Platform numeric user id")
  .requiredOption("--payout <address>", "Payout address")
  .requiredOption("--deposit-id <uint256>", "Deposit ID to claim")
  .requiredOption("--nonce <uint256>", "Nonce")
  .requiredOption("--expiry <seconds>", "Expiry unix seconds")
  .requiredOption("--signature <hex>", "Attester signature")
  .option("--expected-attester <address>", "Expected attester address")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;
    const provider = await getProvider(rpc);
    const chainId = await resolveChainId(provider, g.chainId ?? cfg.chainId);

    const platformId = Number(opts.platform);
    const userId = toBigIntLike(opts.userId);
    const payoutAddress = String(opts.payout);
    const depositId = toBigIntLike(opts.depositId);
    const nonce = toBigIntLike(opts.nonce);
    const expiry = Number(opts.expiry);
    const signature = String(opts.signature);

    const domain = buildDomain(chainId, escrowAddr);
    const recovered = verifyTypedData(domain, ClaimAttestationTypes, { platformId, userId, payoutAddress, depositId, nonce, expiry }, signature);

    const expected = opts.expectedAttester?.toLowerCase();
    const matches = expected ? recovered.toLowerCase() === expected : undefined;

    logOut({ recovered, matches: matches ?? null }, g.json, `Recovered attester: ${recovered}${expected ? ` (matches expected=${matches})` : ""}`);
  });

// claim (on-chain)
program
  .command("claim")
  .description("Submit on-chain claim tx (optionally signing locally if --signature not provided)")
  .requiredOption("--platform <uint8>", "Platform id")
  .requiredOption("--user-id <uint256>", "Platform numeric user id")
  .requiredOption("--payout <address>", "Payout address")
  .requiredOption("--deposit-id <uint256>", "Deposit ID to claim")
  .requiredOption("--nonce <uint256>", "Nonce")
  .requiredOption("--expiry <seconds>", "Expiry unix seconds")
  .option("--signature <hex>", "Attester signature (if omitted and --attester-key provided, will sign)")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const provider = await getProvider(rpc);
    const chainId = await resolveChainId(provider, g.chainId ?? cfg.chainId);
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;

    const relayerKey = g.relayerKey ?? cfg.RELAYER_PRIVATE_KEY ?? g.depositorKey;
    if (!relayerKey) throw new Error("relayer-key (or RELAYER_PRIVATE_KEY / depositor-key) required for claim");

    const relayer = buildWallet(relayerKey, provider);
    const escrow = getEscrow(escrowAddr, relayer);

    const platformId = Number(opts.platform);
    const userId = toBigIntLike(opts.userId);
    const payoutAddress = String(opts.payout);
    const depositId = toBigIntLike(opts.depositId);
    const nonce = toBigIntLike(opts.nonce);
    const expiry = Number(opts.expiry);
    let signature = opts.signature;

    if (!signature) {
      const attesterKey = g.attesterKey ?? cfg.ATTESTER_PRIVATE_KEY;
      if (!attesterKey) throw new Error("signature not provided and no attester-key available to sign");
      const attester = buildWallet(attesterKey, provider);
      const domain = buildDomain(chainId, escrowAddr);
      signature = await attester.signTypedData(domain, ClaimAttestationTypes, { platformId, userId, payoutAddress, depositId, nonce, expiry });
    }

    // Off-chain verification preflight
    const domain = buildDomain(chainId, escrowAddr);
    const recovered = verifyTypedData(domain, ClaimAttestationTypes, { platformId, userId, payoutAddress, depositId, nonce, expiry }, signature);
    // Optional: could compare with expected attester from env if provided

    const attestation = { platformId, userId, payoutAddress, depositId, nonce, expiry };
    const tx = await escrow.claim(depositId, payoutAddress, attestation, signature);
    const receipt = await tx.wait();
    logOut({ hash: tx.hash, status: receipt?.status ?? null, recoveredAttester: recovered }, g.json, `Claim submitted. tx=${tx.hash}`);
  });

// get-deposit (view)
program
  .command("get-deposit")
  .description("Read deposit state")
  .requiredOption("--deposit-id <uint256>", "Deposit ID")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const provider = await getProvider(rpc);
    const chainId = await resolveChainId(provider, g.chainId ?? cfg.chainId);
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;

    const escrow = getEscrow(escrowAddr, provider);
    const id = toBigIntLike(opts.depositId);
    const dep = await escrow.deposits(id);

    // New deposit structure: (depositorAddress, amount, platformId, recipientUserId, depositorUserId, contentUri, claimed)
    const out = {
      chainId,
      escrow: escrowAddr,
      depositId: id.toString(),
      depositorAddress: String(dep.depositorAddress ?? dep[0]),
      amount: (dep.amount ?? dep[1])?.toString(),
      platformId: Number(dep.platformId ?? dep[2] ?? 0),
      recipientUserId: (dep.recipientUserId ?? dep[3])?.toString(),
      depositorUserId: (dep.depositorUserId ?? dep[4])?.toString(),
      contentUri: String(dep.contentUri ?? dep[5] ?? ""),
      claimed: Boolean(dep.claimed ?? dep[6])
    };
    
    const humanOutput = `Deposit ${id.toString()}: claimed=${out.claimed}${
      out.depositorUserId && out.depositorUserId !== "0" ? ` depositorUserId=${out.depositorUserId}` : ""
    }${
      out.contentUri ? ` contentUri="${out.contentUri}"` : ""
    }`;
    
    logOut(out, g.json, humanOutput);
  });

// refund
program
  .command("refund")
  .description("Refund an unclaimed deposit (caller must be depositor)")
  .requiredOption("--deposit-id <uint256>", "Deposit ID")
  .action(async (opts) => {
    const g = program.opts();
    const cfg = loadConfig(process.env);
    const rpc = g.rpc ?? cfg.RPC_URL;
    const provider = await getProvider(rpc);
    const escrowAddr = g.escrow ?? cfg.ESCROW_ADDRESS;

    const depositorKey = g.depositorKey ?? cfg.RELAYER_PRIVATE_KEY; // allow override
    if (!depositorKey) throw new Error("depositor-key (or RELAYER_PRIVATE_KEY) required for refund");

    const wallet = buildWallet(depositorKey, provider);
    const escrow = getEscrow(escrowAddr, wallet);

    const id = toBigIntLike(opts.depositId);
    const tx = await escrow.refund(id);
    const receipt = await tx.wait();
    logOut({ hash: tx.hash, status: receipt?.status ?? null }, g.json, `Refund submitted. tx=${tx.hash}`);
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(msg);
    process.exit(1);
  }
}

main();
