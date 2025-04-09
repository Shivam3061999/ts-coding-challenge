import { Given, Then, When, setDefaultTimeout } from "@cucumber/cucumber";
import {
    AccountBalance,
    AccountBalanceQuery,
    AccountId,
    Client,
    Hbar,
    PrivateKey,
    Status,
    TokenAssociateTransaction,
    TokenCreateTransaction,
    TokenId,
    TokenInfoQuery,
    TokenMintTransaction,
    TokenSupplyType,
    TokenType,
    TransferTransaction,
    Transaction,
    TransactionResponse,
    ReceiptStatusError,
    TokenInfo,
    PublicKey // Added
} from "@hashgraph/sdk";
import { accounts } from "../../src/config"; // Adjust path if needed
import assert from "node:assert";

// Set higher default timeout for steps (e.g., 60 seconds)
setDefaultTimeout(60 * 1000); // INCREASED TIMEOUT

// Use the same client instance, operator might change between scenarios/steps
const client = Client.forTestnet();

// Helper function for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Ensure accounts are loaded and have keys
function getAccount(index: number): { id: AccountId; key: PrivateKey } {
    assert.ok(accounts.length > index, `Account index ${index} out of bounds. Need at least ${index + 1} accounts in config.`);
    const accConfig = accounts[index];
    assert.ok(accConfig?.id, `Account ${index} ID is missing in config.`);
    assert.ok(accConfig?.privateKey, `Account ${index} private key is missing in config.`);
    return {
        id: AccountId.fromString(accConfig.id),
        key: PrivateKey.fromStringED25519(accConfig.privateKey)
    };
}

// Helper: Adjust amount by decimals (Using BigInt for safety)
function adjustForDecimals(amount: number | bigint, decimals: number): bigint {
     const base = BigInt(10 ** decimals); // Simplified calculation
     if (typeof amount === 'number' && !Number.isInteger(amount)) {
         console.warn("adjustForDecimals received a float amount, precision issues may occur:", amount);
         return BigInt(Math.round(amount * (10 ** decimals)));
     }
     return BigInt(amount) * base;
}

// Helper: Get token balance (returns bigint)
async function getTokenBalance(accountId: AccountId, tokenId: TokenId, client: Client): Promise<bigint> {
    try {
        const balanceQuery = new AccountBalanceQuery().setAccountId(accountId);
        const balance = await balanceQuery.execute(client);
        // Use tokenId.toString() as the key for the map
        const tokenBalance = balance.tokens?.get(tokenId.toString());
        return tokenBalance ? BigInt(tokenBalance.toNumber()) : BigInt(0); // Use BigInt
    } catch (error) {
        console.error(`Error getting token balance for ${accountId} / ${tokenId}: ${error}`);
        // If account not found or other query issue, return 0 for simplicity in checks,
        // but this could mask underlying problems.
        return BigInt(0);
    }
}

// Helper: Associate account with token (with checks)
async function associateToken(accountId: AccountId, privateKey: PrivateKey, tokenId: TokenId, payerClient: Client) {
    // Check if already associated
    try {
        const currentBalanceUnits = await getTokenBalance(accountId, tokenId, payerClient);
        // If balance query succeeds (even returning 0), association exists.
        console.log(`Account ${accountId.toString()} already associated with token ${tokenId.toString()} (balance check successful).`);
        return;
    } catch (e) {
        // If balance query fails, association might be missing. Proceed.
         console.warn(`Balance check before association failed for ${accountId} (may need association): ${e}`);
    }

    console.log(`Attempting association for account ${accountId.toString()} with token ${tokenId.toString()}...`);
    try {
        const associateTx = await new TokenAssociateTransaction()
            .setAccountId(accountId)
            .setTokenIds([tokenId])
            .freezeWith(payerClient); // Freeze with the client that will pay

        const signedTx = await associateTx.sign(privateKey); // Sign with the account being associated
        const txResponse = await signedTx.execute(payerClient); // Execute with the paying client
        const receipt = await txResponse.getReceipt(payerClient);
        assert.strictEqual(receipt.status, Status.Success, `Token association failed for account ${accountId} and token ${tokenId}: ${receipt.status.toString()}`);
        console.log(`Association successful for account ${accountId.toString()} with token ${tokenId.toString()}`);
        await delay(5000); // Short delay after association
    } catch (error: any) {
        // Catch potential "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT" specifically
        if (error instanceof ReceiptStatusError && error.status === Status.TokenAlreadyAssociatedToAccount) {
             console.warn(`Account ${accountId.toString()} was already associated with token ${tokenId.toString()} (caught TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT).`);
        } else {
            console.error(`Unexpected error during token association for ${accountId} with ${tokenId}:`, error);
            throw error; // Re-throw other errors
        }
    }
}

// Helper: Set token balance by transferring from Treasury (Acc 0)
async function setTokenBalance(targetAccountId: AccountId, targetAccountKey: PrivateKey, tokenId: TokenId, targetBalanceTokens: number, decimals: number, treasuryClient: Client) {
    const targetBalanceUnits = adjustForDecimals(targetBalanceTokens, decimals);
    const currentBalanceUnits = await getTokenBalance(targetAccountId, tokenId, treasuryClient);
    const differenceUnits = targetBalanceUnits - currentBalanceUnits;

    if (differenceUnits === BigInt(0)) {
        console.log(`Account ${targetAccountId} already has desired balance of ${targetBalanceTokens} tokens.`);
        return;
    }

    // Assume treasury is the operator of treasuryClient (Account 0)
    const treasuryId = treasuryClient.operatorAccountId;
    const treasuryKey = treasuryClient._operator;
    assert.ok(treasuryId, "Treasury client operator ID not set");
    assert.ok(treasuryKey, "Treasury client operator key not set");
    assert.ok(treasuryId.equals(getAccount(0).id), "Treasury client operator is not Account 0");

    console.log(`Adjusting token balance for ${targetAccountId}: current=${currentBalanceUnits}, target=${targetBalanceUnits}, diff=${differenceUnits}`);

    const transferTx = new TransferTransaction();
    let txRequiresTargetSignature = false;

    if (differenceUnits > 0) { // Need to send TO targetAccount FROM treasury
        console.log(`Transferring ${differenceUnits} units FROM treasury ${treasuryId} TO ${targetAccountId}`);
        transferTx
            .addTokenTransfer(tokenId, treasuryId, Number(-differenceUnits)) // From Acc 1
            .addTokenTransfer(tokenId, targetAccountId, Number(differenceUnits));  // To Acc 2
        // Treasury (operator) signs automatically via execute
    } else { // Need to send FROM targetAccount TO treasury
        const amountToSend = -differenceUnits; // Make positive BigInt
        console.log(`Transferring ${amountToSend} units FROM ${targetAccountId} TO treasury ${treasuryId}`);
        transferTx
            .addTokenTransfer(tokenId, targetAccountId, Number(-amountToSend))
            .addTokenTransfer(tokenId, treasuryId, Number(amountToSend));
        txRequiresTargetSignature = true; // Target account must sign to send funds out
    }

    await transferTx.freezeWith(treasuryClient); // Freeze with treasury client

    if (txRequiresTargetSignature) {
       await transferTx.sign(targetAccountKey); // Sign with the target account's key
       console.log(`Transfer transaction signed by target account ${targetAccountId}`);
    }

    // Treasury client executes
    try {
        const txResponse = await transferTx.execute(treasuryClient);
        const receipt = await txResponse.getReceipt(treasuryClient);
        // Check specifically for success
        if (receipt.status !== Status.Success) {
             throw new Error(`Setup transfer failed with status: ${receipt.status.toString()}`);
        }
        console.log(`Successfully set token balance for ${targetAccountId} to ${targetBalanceTokens} tokens.`);
    } catch (error) {
         console.error(`Error executing setup transfer for ${targetAccountId}:`, error);
         // Attempt to get receipt details if possible
         if (error instanceof TransactionResponse) {
            try { const r = await error.getReceipt(treasuryClient); console.error("Receipt Status:", r.status.toString()); } catch {}
         }
         throw error; // Re-throw after logging
    }
    await delay(5000); // Wait after transfer
}

// --- Cucumber Context (`this`) ---
// Stores scenario-specific data
// this.account1Id / this.account1Key (Primary account, usually treasury)
// this.account2Id / this.account2Key
// this.account3Id / this.account3Key
// this.account4Id / this.account4Key
// this.tokenId: TokenId | undefined
// this.tokenDecimals: number | undefined
// this.createdTransaction: Transaction | undefined
// this.balanceBefore: Hbar | undefined
// ---

// --- Scenario Setup Steps ---

// Generic setup for the primary account (Acc 0)
Given(/^A Hedera account with more than (\d+) hbar$/, async function (minHbar: number) {
    const acc = getAccount(0);
    this.account1Id = acc.id;
    this.account1Key = acc.key;
    client.setOperator(this.account1Id, this.account1Key); // Set operator for this scenario
    console.log(`Operator set to Account 1 (Treasury): ${this.account1Id.toString()}`);

    const balance = await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client);
    console.log(`Account 1 ${this.account1Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
    assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 1 ${this.account1Id.toString()} needs more than ${minHbar} hbar, but has ${balance.hbars.toString()}`);
});

// Setup for Account 2
Given(/^A second Hedera account$/, async function () {
    const acc = getAccount(1);
    this.account2Id = acc.id;
    this.account2Key = acc.key;
    console.log(`Loaded Account 2: ${this.account2Id.toString()}`);
    // Association happens when token is known and needed
});

// Setup for Account 3 (simplified HBAR check)
Given(/^A third Hedera account with (\d+) hbar$/, async function (minHbar: number) {
    const acc = getAccount(2);
    this.account3Id = acc.id;
    this.account3Key = acc.key;
    console.log(`Loaded Account 3: ${this.account3Id.toString()}`);
    if (minHbar > 0) { // Only check if > 0 required
        assert.ok(client.operatorAccountId, "Client operator needed to check Account 3 HBAR");
        const balance = await new AccountBalanceQuery().setAccountId(this.account3Id).execute(client);
        console.log(`Account 3 ${this.account3Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
        assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 3 ${this.account3Id.toString()} needs more than ${minHbar} hbar.`);
    }
});

// Setup for Account 4 (simplified HBAR check)
Given(/^A fourth Hedera account with (\d+) hbar$/, async function (minHbar: number) {
    const acc = getAccount(3);
    this.account4Id = acc.id;
    this.account4Key = acc.key;
    console.log(`Loaded Account 4: ${this.account4Id.toString()}`);
    if (minHbar > 0) { // Only check if > 0 required
        assert.ok(client.operatorAccountId, "Client operator needed to check Account 4 HBAR");
        const balance = await new AccountBalanceQuery().setAccountId(this.account4Id).execute(client);
        console.log(`Account 4 ${this.account4Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
        assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 4 ${this.account4Id.toString()} needs more than ${minHbar} hbar.`);
    }
});

// --- Token Creation Steps ---

When(/^I create a token named (.+) \((.+)\)$/, async function (tokenName: string, tokenSymbol: string) {
    // Creates a MINTABLE token
    assert.ok(this.account1Id && this.account1Key, "Account 1 context needed for mintable token creation");
    client.setOperator(this.account1Id, this.account1Key);

    const decimals = 2; // Hardcoded based on feature file Then steps

    console.log(`Creating MINTABLE token: Name=${tokenName}, Symbol=${tokenSymbol}, Decimals=${decimals}, Treasury=${this.account1Id}`);

    const createTx = await new TokenCreateTransaction()
        .setTokenName(tokenName)
        .setTokenSymbol(tokenSymbol)
        .setDecimals(decimals)
        .setInitialSupply(0) // Mintable starts at 0
        .setTokenType(TokenType.FungibleCommon)
        .setSupplyType(TokenSupplyType.Infinite)
        .setTreasuryAccountId(this.account1Id)
        .setAdminKey(this.account1Key.publicKey)
        .setSupplyKey(this.account1Key.publicKey) // Supply key makes it mintable
        .execute(client);

    const receipt = await createTx.getReceipt(client);
    assert.strictEqual(receipt.status, Status.Success, `Mintable token creation failed: ${receipt.status.toString()}`);
    assert.ok(receipt.tokenId, "Token ID missing from mintable token creation receipt.");

    this.tokenId = receipt.tokenId; // Store in context
    this.tokenDecimals = decimals; // Store in context
    console.log(`Created MINTABLE token ID: ${this.tokenId.toString()}`);
    await delay(9000);
});

When(/^I create a fixed supply token named (.+) \((.+)\) with (\d+) tokens$/, async function (tokenName: string, tokenSymbol: string, initialTokens: number) {
    // Creates a FIXED supply token
    assert.ok(this.account1Id && this.account1Key, "Account 1 context needed for fixed supply token creation");
    client.setOperator(this.account1Id, this.account1Key);

    const decimals = 2; // Hardcoded based on feature file Then steps
    const initialSupplyUnits = adjustForDecimals(initialTokens, decimals); // Use helper

    console.log(`Creating FIXED token: Name=${tokenName}, Symbol=${tokenSymbol}, Decimals=${decimals}, InitialSupply=${initialTokens} (${initialSupplyUnits} units), Treasury=${this.account1Id}`);

    const createTx = await new TokenCreateTransaction()
        .setTokenName(tokenName)
        .setTokenSymbol(tokenSymbol)
        .setDecimals(decimals)
        .setInitialSupply(Number(initialSupplyUnits)) // Set initial supply in units
        .setTokenType(TokenType.FungibleCommon)
        .setSupplyType(TokenSupplyType.Finite)
        .setMaxSupply(Number(initialSupplyUnits)) // Max supply required for Finite
        .setTreasuryAccountId(this.account1Id)
        .setAdminKey(this.account1Key.publicKey)
        // NO supply key for fixed supply
        .execute(client);

    const receipt = await createTx.getReceipt(client);
    assert.strictEqual(receipt.status, Status.Success, `Fixed supply token creation failed: ${receipt.status.toString()}`);
    assert.ok(receipt.tokenId, "Token ID missing from fixed supply token creation receipt.");

    this.tokenId = receipt.tokenId; // Store in context
    this.tokenDecimals = decimals; // Store in context
    console.log(`Created FIXED token ID: ${this.tokenId.toString()}`);
    await delay(9000);
});

// Add this specific step definition:
Given('A first hedera account with more than {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log(`--- Setup: Account 1 with HBAR > ${minHbar} and ${balanceTokens} HTT ---`);
  // 1. Ensure Account 1 exists and has HBAR (Redundant check if previous step ran, but safe)
  const acc = getAccount(0);
  this.account1Id = acc.id;
  this.account1Key = acc.key;
  this.account = this.account1Id;
  this.privKey = this.account1Key;
  client.setOperator(this.account1Id, this.account1Key);
  const balance = await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client);
  console.log(`Account 1 HBAR balance: ${balance.hbars.toString()}`);
  assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 1 needs more than ${minHbar} hbar.`);

  // 2. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set in context before setting balance for Account 1");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set in context");

  // 3. Set/Verify token balance
  console.log(`Setting initial token balance for Account 1 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account1Id, this.account1Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

// Add this specific step definition:
Given('A second Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log(`--- Setup: Account 2 with HBAR >= ${minHbar} and ${balanceTokens} HTT ---`);
  // 1. Ensure Account 2 exists (Redundant check if previous step ran, but safe)
  const acc = getAccount(1);
  this.account2Id = acc.id;
  this.account2Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays for checks/setup

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
       const balance = await new AccountBalanceQuery().setAccountId(this.account2Id).execute(client);
       console.log(`Account 2 HBAR balance: ${balance.hbars.toString()}`);
        assert.ok(balance.hbars.toBigNumber().isGreaterThanOrEqualTo(minHbar), `Account 2 needs >= ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 2");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 2 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account2Id, this.account2Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

// Add this specific step definition:
Given('A third Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log(`--- Setup: Account 3 with HBAR >= ${minHbar} and ${balanceTokens} HTT ---`);
  // 1. Ensure Account 3 exists
  const acc = getAccount(2);
  this.account3Id = acc.id;
  this.account3Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
      const balance = await new AccountBalanceQuery().setAccountId(this.account3Id).execute(client);
      console.log(`Account 3 HBAR balance: ${balance.hbars.toString()}`);
      assert.ok(balance.hbars.toBigNumber().isGreaterThanOrEqualTo(minHbar), `Account 3 needs >= ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 3");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 3 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account3Id, this.account3Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

// Add this specific step definition:
Given('A fourth Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log(`--- Setup: Account 4 with HBAR >= ${minHbar} and ${balanceTokens} HTT ---`);
  // 1. Ensure Account 4 exists
  const acc = getAccount(3);
  this.account4Id = acc.id;
  this.account4Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
      const balance = await new AccountBalanceQuery().setAccountId(this.account4Id).execute(client);
      console.log(`Account 4 HBAR balance: ${balance.hbars.toString()}`);
      assert.ok(balance.hbars.toBigNumber().isGreaterThanOrEqualTo(minHbar), `Account 4 needs >= ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 4");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 4 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account4Id, this.account4Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});


// Add this specific step definition (ensure regex matches feature file!)
// NOTE: The original error showed 3 int params, but the text implies 4 amounts.
// This implementation assumes 4 amounts based on the text description. Adjust if needed.
When('A transaction is created to transfer {int} HTT tokens out of the first account, {int} HTT tokens out of the second account, {int} HTT tokens into the third account, and {int} HTT tokens into the fourth account',
async function (out1Tokens: number, out2Tokens: number, in3Tokens: number, in4Tokens: number) {
  console.log("--- Creating Multi-Party Transaction ---");
  assert.ok(this.account1Id && this.account1Key, "Acc 1 missing");
  assert.ok(this.account2Id && this.account2Key, "Acc 2 missing");
  assert.ok(this.account3Id, "Acc 3 missing");
  assert.ok(this.account4Id, "Acc 4 missing");
  assert.ok(this.tokenId, "Token ID missing");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals missing");

  const out1Units = adjustForDecimals(out1Tokens, this.tokenDecimals);
  const out2Units = adjustForDecimals(out2Tokens, this.tokenDecimals);
  const in3Units = adjustForDecimals(in3Tokens, this.tokenDecimals);
  const in4Units = adjustForDecimals(in4Tokens, this.tokenDecimals);

  assert.strictEqual((out1Units + out2Units), (in3Units + in4Units), "Multi-transfer amounts unbalanced");

  console.log(`Creating multi-transfer: ${out1Tokens} from Acc1, ${out2Tokens} from Acc2, ${in3Tokens} to Acc3, ${in4Tokens} to Acc4`);
  const transferTx = new TransferTransaction()
      .addTokenTransfer(this.tokenId, this.account1Id, -Number(out1Units)) // Convert to number
      .addTokenTransfer(this.tokenId, this.account2Id, -Number(out2Units)) // Convert to number
      .addTokenTransfer(this.tokenId, this.account3Id, Number(in3Units))   // Convert to number
      .addTokenTransfer(this.tokenId, this.account4Id, Number(in4Units));  // Convert to number

  client.setOperator(this.account1Id, this.account1Key); // Freeze with payer (Acc 1)
  await transferTx.freezeWith(client);
  console.log("Multi-party transaction created and frozen.");
  this.createdTransaction = transferTx;
});
// Step used in transfer scenarios to create the specific token needed
Given(/^A token named (.+) \((.+)\) with (\d+) tokens$/, async function (tokenName: string, tokenSymbol: string, initialTokens: number) {
    // Creates a FIXED supply token with Account 1 as treasury for transfer tests
    assert.ok(this.account1Id && this.account1Key, "Account 1 context must be set before creating token for transfer");
    client.setOperator(this.account1Id, this.account1Key); // Ensure operator is Account 1

    const decimals = 2; // Hardcoded assumption
    this.tokenDecimals = decimals;
    const initialSupplyUnits = adjustForDecimals(initialTokens, decimals); // Use helper

    console.log(`Creating FIXED token for transfer: Name=${tokenName}, Symbol=${tokenSymbol}, Decimals=${decimals}, InitialSupply=${initialTokens} (${initialSupplyUnits} units), Treasury=${this.account1Id}`);

    const createTx = await new TokenCreateTransaction()
        .setTokenName(tokenName)
        .setTokenSymbol(tokenSymbol)
        .setDecimals(decimals)
        .setInitialSupply(Number(initialSupplyUnits))
        .setTokenType(TokenType.FungibleCommon)
        .setSupplyType(TokenSupplyType.Finite)
        .setMaxSupply(Number(initialSupplyUnits))
        .setTreasuryAccountId(this.account1Id) // Account 1 is treasury
        .setAdminKey(this.account1Key.publicKey)
        // NO Supply Key
        .execute(client);

    const receipt = await createTx.getReceipt(client);
    assert.strictEqual(receipt.status, Status.Success, `Token creation for transfer scenario failed: ${receipt.status.toString()}`);
    assert.ok(receipt.tokenId, "Token ID not found in receipt for transfer token.");

    this.tokenId = receipt.tokenId; // Store in context
    console.log(`Created FIXED token for transfer with ID: ${this.tokenId.toString()}`);
    await delay(9000); // Allow propagation

    // Associate other accounts IMMEDIATELY if they exist in context for this scenario
    client.setOperator(this.account1Id, this.account1Key); // Ensure Acc 1 pays for association
    if (this.account2Id && this.account2Key) await associateToken(this.account2Id, this.account2Key, this.tokenId, client);
    if (this.account3Id && this.account3Key) await associateToken(this.account3Id, this.account3Key, this.tokenId, client);
    if (this.account4Id && this.account4Key) await associateToken(this.account4Id, this.account4Key, this.tokenId, client);
});


// --- Steps to SET initial balances ---

// Use these steps AFTER the token has been created and accounts defined/associated
// Replace the existing definition for this step
Given(/^The first account holds (\d+) HTT tokens$/, async function (balanceTokens: number) {
  assert.ok(this.account1Id && this.account1Key, "Account 1 context must be set");
  assert.ok(this.tokenId, "Token ID must be set");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");
  client.setOperator(this.account1Id, this.account1Key); // Treasury client

  const expectedUnits = adjustForDecimals(balanceTokens, this.tokenDecimals);
  const actualUnits = await getTokenBalance(this.account1Id, this.tokenId, client);

  console.log(`SETUP CHECK for Account 1: Expected ${balanceTokens} HTT (${expectedUnits} units), Actual: ${actualUnits} units`);

  if (actualUnits === expectedUnits) {
      console.log(`Account 1 already holds the desired ${balanceTokens} tokens.`);
      return; // Nothing to do
  }

  // If we expect FEWER tokens than the treasury currently holds (common setup issue)
  if (expectedUnits < actualUnits) {
      const difference = actualUnits - expectedUnits;
      console.warn(`Account 1 (Treasury) holds ${actualUnits} units, but test expects ${expectedUnits}. Transferring ${difference} units away...`);

      // Need a temporary sink account (use Account 3 or 4 if available, otherwise fail)
      // Let's use Account 3 for simplicity here. Ensure it exists.
      const sinkAccount = getAccount(2); // Using Account 3 as sink
      assert.ok(sinkAccount, "Need Account 3 defined in config to transfer excess treasury funds");
      await associateToken(sinkAccount.id, sinkAccount.key, this.tokenId, client); // Ensure sink is associated
      const transferTx = new TransferTransaction()
          .addTokenTransfer(this.tokenId, this.account1Id, Number(-difference)) // Send from treasury
          .addTokenTransfer(this.tokenId, sinkAccount.id, Number(difference));    // Send to sink

      await transferTx.freezeWith(client);
      // No extra signature needed as treasury (operator) is sending
      const txResponse = await transferTx.execute(client);
      const receipt = await txResponse.getReceipt(client);
      assert.strictEqual(receipt.status, Status.Success, `Failed to transfer excess tokens from treasury during setup: ${receipt.status.toString()}`);
      console.log(`Transferred ${difference} excess units from Account 1 to ${sinkAccount.id}.`);
      await delay(5000);

      // Re-verify balance after transfer
      const finalUnits = await getTokenBalance(this.account1Id, this.tokenId, client);
       assert.strictEqual(finalUnits, expectedUnits, `SETUP FAIL: Account 1 balance is ${finalUnits} units after attempting to adjust to ${expectedUnits} units.`);

  } else {
      // If we expect MORE tokens than treasury holds (less common for fixed tokens, maybe needs minting?)
      // For now, consider this a setup failure, as setTokenBalance handles sending *to* other accounts.
       assert.fail(`SETUP FAIL: Account 1 (Treasury) expected ${expectedUnits} units, but holds only ${actualUnits}. Cannot adjust upwards in this step.`);
  }
  console.log(`Account 1 setup to hold ${balanceTokens} tokens.`);
});

Given(/^The second account holds (\d+) HTT tokens$/, async function (balanceTokens: number) {
    assert.ok(this.account2Id && this.account2Key, "Account 2 context must be set");
    assert.ok(this.tokenId, "Token ID must be set");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");
    assert.ok(this.account1Id && this.account1Key, "Account 1 (Treasury) context must be set to pay for setup");
    client.setOperator(this.account1Id, this.account1Key); // Treasury client pays for setup

    await associateToken(this.account2Id, this.account2Key, this.tokenId, client); // Ensure associated
    console.log(`Setting initial token balance for Account 2 to ${balanceTokens} HTT`);
    await setTokenBalance(this.account2Id, this.account2Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

Given(/^The third account holds (\d+) HTT tokens$/, async function (balanceTokens: number) {
    assert.ok(this.account3Id && this.account3Key, "Account 3 context must be set");
    assert.ok(this.tokenId, "Token ID must be set");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");
    assert.ok(this.account1Id && this.account1Key, "Account 1 (Treasury) context must be set to pay for setup");
    client.setOperator(this.account1Id, this.account1Key); // Treasury client pays for setup

    await associateToken(this.account3Id, this.account3Key, this.tokenId, client); // Ensure associated
    console.log(`Setting initial token balance for Account 3 to ${balanceTokens} HTT`);
    await setTokenBalance(this.account3Id, this.account3Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

// Given('A first hedera account with more than {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
//   console.log("--- Setting up Account 1 with HBAR and Tokens ---");
//   const acc = getAccount(0);
//   this.account1Id = acc.id;
//   this.account1Key = acc.key;
//   client.setOperator(this.account1Id, this.account1Key);

//   // Check HBAR balance
//   const balance = await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client);
//   console.log(`Account 1 ${this.account1Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
//   assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 1 ${this.account1Id.toString()} needs more than ${minHbar} hbar, but has ${balance.hbars.toString()}`);

//   // Ensure Token exists
//   assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 1");
//   assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

//   // Set token balance (includes association)
//   console.log(`Setting initial token balance for Account 1 to ${balanceTokens} HTT`);
//   const expectedUnits = adjustForDecimals(balanceTokens, this.tokenDecimals);
//   const actualUnits = await getTokenBalance(this.account1Id, this.tokenId, client);

//   // Debugging output
//   console.log(`Expected Units: ${expectedUnits}, Actual Units: ${actualUnits}, Token Decimals: ${this.tokenDecimals}`);

//   assert.strictEqual(actualUnits, expectedUnits, `SETUP FAIL: Account 1 (Treasury) expected ${expectedUnits} units, but holds ${actualUnits}. Check token creation.`);
//   console.log(`Verified Account 1 holds ${balanceTokens} tokens.`);
// });

// Add this step definition if it's missing or incorrect
Given('A first hedera account with more than {int} hbar', async function (minHbar: number) {
  console.log("--- Setup: Account 1 with HBAR (Transfer Scenarios) ---");
  const acc = getAccount(0);
  this.account1Id = acc.id;
  this.account1Key = acc.key;
  this.account = this.account1Id; // Generic context needed by other steps
  this.privKey = this.account1Key; // Generic context

  client.setOperator(this.account1Id, this.account1Key);
  console.log(`Operator set to Account 1: ${this.account1Id.toString()}`);
  const balance = await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client);
  console.log(`Account 1 ${this.account1Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
  assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 1 ${this.account1Id.toString()} needs more than ${minHbar} hbar, but has ${balance.hbars.toString()}`);
});

Given(/^The fourth account holds (\d+) HTT tokens$/, async function (balanceTokens: number) {
    assert.ok(this.account4Id && this.account4Key, "Account 4 context must be set");
    assert.ok(this.tokenId, "Token ID must be set");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");
    assert.ok(this.account1Id && this.account1Key, "Account 1 (Treasury) context must be set to pay for setup");
    client.setOperator(this.account1Id, this.account1Key); // Treasury client pays for setup

    await associateToken(this.account4Id, this.account4Key, this.tokenId, client); // Ensure associated
    console.log(`Setting initial token balance for Account 4 to ${balanceTokens} HTT`);
    await setTokenBalance(this.account4Id, this.account4Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

// --- Token Property Verification Steps ---

Then(/^The token has the name "([^"]*)"$/, async function (expectedName: string) {
    assert.ok(this.tokenId, "Token ID context not set for name check");
    const info : TokenInfo = await new TokenInfoQuery().setTokenId(this.tokenId).execute(client);
    assert.strictEqual(info.name, expectedName, `Expected token name ${expectedName}, but got ${info.name}`);
    console.log(`Verified token name: ${info.name}`);
});

Then(/^The token has the symbol "([^"]*)"$/, async function (expectedSymbol: string) {
    assert.ok(this.tokenId, "Token ID context not set for symbol check");
    const info : TokenInfo = await new TokenInfoQuery().setTokenId(this.tokenId).execute(client);
    assert.strictEqual(info.symbol, expectedSymbol, `Expected token symbol ${expectedSymbol}, but got ${info.symbol}`);
    console.log(`Verified token symbol: ${info.symbol}`);
});

Then(/^The token has (\d+) decimals$/, async function (expectedDecimals: number) {
    assert.ok(this.tokenId, "Token ID context not set for decimals check");
    // If decimals already stored, verify against that first
    if (this.tokenDecimals !== undefined) {
        assert.strictEqual(this.tokenDecimals, expectedDecimals, `Stored decimals ${this.tokenDecimals} don't match expected ${expectedDecimals}`);
    }
    const info : TokenInfo = await new TokenInfoQuery().setTokenId(this.tokenId).execute(client);
    assert.strictEqual(info.decimals, expectedDecimals, `Expected token decimals ${expectedDecimals}, but got ${info.decimals}`);
    this.tokenDecimals = info.decimals; // Ensure context is updated/correct
    console.log(`Verified token decimals: ${info.decimals}`);
});

Then(/^The token is owned by the account$/, async function () { // Assumes "the account" is Acc 1
    assert.ok(this.tokenId, "Token ID context not set for owner check");
    assert.ok(this.account1Id, "Account 1 context (treasury) not set for owner check");
    const info : TokenInfo = await new TokenInfoQuery().setTokenId(this.tokenId).execute(client);
    assert.ok(info.treasuryAccountId?.equals(this.account1Id), `Expected treasury ${this.account1Id.toString()}, but got ${info.treasuryAccountId?.toString()}`);
    console.log(`Verified token treasury: ${info.treasuryAccountId?.toString()}`);
});

Then(/^The total supply of the token is (\d+)$/, async function (expectedSupplyTokens: number) {
    assert.ok(this.tokenId, "Token ID context not set for supply check");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals context not set for supply check");
    const expectedSupplyUnits : bigint = adjustForDecimals(expectedSupplyTokens, this.tokenDecimals);

    const info : TokenInfo = await new TokenInfoQuery().setTokenId(this.tokenId).execute(client);
    // Compare BigInt values
    assert.strictEqual(info.totalSupply.toNumber(), Number(expectedSupplyUnits), `Expected total supply ${expectedSupplyUnits} units, but got ${info.totalSupply.toString()}`);
    console.log(`Verified token total supply: ${info.totalSupply.toString()} units`);
});

// --- Token Minting Steps ---

Then(/^An attempt to mint (\d+) additional tokens succeeds$/, async function (amountToMintTokens: number) {
    assert.ok(this.tokenId, "Token ID context not set for minting");
    assert.ok(this.account1Key, "Treasury/Supply key (Account 1) context not set for minting");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals context not set for minting");
    client.setOperator(this.account1Id, this.account1Key); // Ensure operator has supply key

    const amountToMintUnits = adjustForDecimals(amountToMintTokens, this.tokenDecimals);
    console.log(`Attempting to mint ${amountToMintTokens} tokens (${amountToMintUnits} units)...`);

    const mintTx = await new TokenMintTransaction()
        .setTokenId(this.tokenId)
        .setAmount(Number(amountToMintUnits))
        .execute(client); // Operator has supply key

    const receipt = await mintTx.getReceipt(client);
    assert.strictEqual(receipt.status, Status.Success, `Token minting failed unexpectedly: ${receipt.status.toString()}`);
    console.log(`Successfully minted ${amountToMintTokens} tokens. New supply: ${receipt.totalSupply?.toString()} units`);
    await delay(5000);
});

Then(/^An attempt to mint tokens fails$/, async function () {
    assert.ok(this.tokenId, "Token ID context not set for failing mint");
    assert.ok(this.account1Id && this.account1Key, "Account 1 context (payer) not set for failing mint");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals context not set for failing mint");
    client.setOperator(this.account1Id, this.account1Key); // Set operator to pay

    const amountToMintUnits = adjustForDecimals(1, this.tokenDecimals); // Try to mint 1 unit
    console.log(`Attempting to mint ${amountToMintUnits} units for fixed supply token (expected to fail)...`);

    try {
        const mintTx = await new TokenMintTransaction()
            .setTokenId(this.tokenId)
            .setAmount(Number(amountToMintUnits))
            .execute(client);

         const receipt = await mintTx.getReceipt(client);
         console.error("Minting receipt status (should have failed):", receipt.status.toString());
         assert.fail("Minting succeeded unexpectedly for a fixed supply token.");

    } catch (error) {
        console.log("Caught error during mint attempt:", error instanceof Error ? error.message : error);
        // Check specifically for TOKEN_HAS_NO_SUPPLY_KEY
        assert.ok(
            error instanceof ReceiptStatusError && error.status === Status.TokenHasNoSupplyKey,
            `Expected 'TOKEN_HAS_NO_SUPPLY_KEY' (Status Code: ${Status.TokenHasNoSupplyKey._code}) error, but got: ${error}`
        );
        console.log("Verified that minting failed as expected (TOKEN_HAS_NO_SUPPLY_KEY).");
    }
});


// --- Token Transfer Action Steps ---

// Step to CREATE the transaction object and store it
When(/^The first account creates a transaction to transfer (\d+) HTT tokens to the second account$/, async function (amountTokens: number) {
    assert.ok(this.account1Id, "Account 1 context not set for creating transfer");
    assert.ok(this.account2Id, "Account 2 context not set for creating transfer");
    assert.ok(this.tokenId, "Token ID context not set for creating transfer");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals context not set");

    const amountUnits = adjustForDecimals(amountTokens, this.tokenDecimals);
    console.log(`Creating transaction: Transfer ${amountTokens} tokens (${amountUnits} units) from Acc1 to Acc2`);
    const transferTx = new TransferTransaction()
        .addTokenTransfer(this.tokenId, this.account1Id, Number(-amountUnits)) // From Acc 1
        .addTokenTransfer(this.tokenId, this.account2Id, Number(amountUnits));  // To Acc 2

    this.createdTransaction = transferTx; // Store unsigned transaction
    console.log("Simple transfer transaction created.");
});

// Step to CREATE the transaction object for recipient-pays
When(/^The second account creates a transaction to transfer (\d+) HTT tokens to the first account$/, async function (amountTokens: number) {
    assert.ok(this.account1Id, "Account 1 context not set for recipient-pays");
    assert.ok(this.account2Id && this.account2Key, "Account 2 context not set for recipient-pays");
    assert.ok(this.tokenId, "Token ID context not set for recipient-pays");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals context not set");

    const amountUnits = adjustForDecimals(amountTokens, this.tokenDecimals);
    console.log(`Creating transaction: Transfer ${amountTokens} tokens (${amountUnits} units) from Acc2 to Acc1 (Recipient Acc1 to pay)`);
    const transferTx = new TransferTransaction()
        .addTokenTransfer(this.tokenId, this.account2Id, Number(-amountUnits)) // From Acc 2
        .addTokenTransfer(this.tokenId, this.account1Id, Number(amountUnits));  // To Acc 1

    // Freeze with a client (payer doesn't matter for freezing)
    client.setOperator(this.account1Id, this.account1Key); // Use Acc 1 operator for freezing convenience
    await transferTx.freezeWith(client);

    // SIGN with the SENDER's key (Account 2)
    const signedTx = await transferTx.sign(this.account2Key);
    console.log("Transaction created by Account 2, frozen, and signed by Account 2.");

    this.createdTransaction = signedTx; // Store signed transaction
});

// Step to CREATE the transaction object for multi-party
When(/^A transaction is created to transfer (\d+) HTT tokens out of the first account, (\d+) HTT tokens out of the second account, (\d+) HTT tokens into the third account, and (\d+) HTT tokens into the fourth account$/,
async function (out1Tokens: number, out2Tokens: number, in3Tokens: number, in4Tokens: number) {
    assert.ok(this.account1Id, "Acc 1 missing for multi-transfer");
    assert.ok(this.account2Id, "Acc 2 missing for multi-transfer");
    assert.ok(this.account3Id, "Acc 3 missing for multi-transfer");
    assert.ok(this.account4Id, "Acc 4 missing for multi-transfer");
    assert.ok(this.tokenId, "Token ID missing for multi-transfer");
    assert.ok(this.tokenDecimals !== undefined, "Token decimals missing");

    const out1Units = adjustForDecimals(out1Tokens, this.tokenDecimals);
    const out2Units = adjustForDecimals(out2Tokens, this.tokenDecimals);
    const in3Units = adjustForDecimals(in3Tokens, this.tokenDecimals);
    const in4Units = adjustForDecimals(in4Tokens, this.tokenDecimals);

    // Balance check
    assert.strictEqual((out1Units + out2Units), (in3Units + in4Units), "Multi-transfer amounts unbalanced");

    console.log(`Creating multi-transfer: ${out1Tokens} from Acc1, ${out2Tokens} from Acc2, ${in3Tokens} to Acc3, ${in4Tokens} to Acc4`);
    const transferTx = new TransferTransaction()
        .addTokenTransfer(this.tokenId, this.account1Id, Number(-out1Units)) // From Acc 1
        .addTokenTransfer(this.tokenId, this.account2Id, Number(-out2Units)) // From Acc 2
        .addTokenTransfer(this.tokenId, this.account3Id, Number(in3Units))   // To Acc 3
        .addTokenTransfer(this.tokenId, this.account4Id, Number(in4Units));  // To Acc 4

    // Freeze with payer (Acc 1)
    client.setOperator(this.account1Id, this.account1Key);
    await transferTx.freezeWith(client);
    console.log("Multi-party transaction created and frozen.");

    this.createdTransaction = transferTx; // Store unsigned frozen tx
});

When('A transaction is created to transfer {int} HTT tokens out of the first and second account and {int} HTT tokens into the third account and {int} HTT tokens into the fourth account', async function (outTokens: number, in3Tokens: number, in4Tokens: number) {
  assert.ok(this.account1Id, "Account 1 context must be set for multi-transfer");
  assert.ok(this.account2Id, "Account 2 context must be set for multi-transfer");
  assert.ok(this.account3Id, "Account 3 context must be set for multi-transfer");
  assert.ok(this.account4Id, "Account 4 context must be set for multi-transfer");
  assert.ok(this.tokenId, "Token ID context must be set for multi-transfer");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals context must be set for multi-transfer");

  const outUnits = adjustForDecimals(outTokens, this.tokenDecimals);
  const in3Units = adjustForDecimals(in3Tokens, this.tokenDecimals);
  const in4Units = adjustForDecimals(in4Tokens, this.tokenDecimals);
  // Ensure the total outflow matches the total inflow
  assert.strictEqual(Number(outUnits) * 2, Number(in3Units) + Number(in4Units), "Multi-transfer amounts are unbalanced");

  console.log(`Creating multi-transfer: ${outTokens} from Acc1 and Acc2, ${in3Tokens} to Acc3, ${in4Tokens} to Acc4`);
  const transferTx = new TransferTransaction()
      .addTokenTransfer(this.tokenId, this.account1Id, Number(-outUnits)) // From Acc 1
      .addTokenTransfer(this.tokenId, this.account2Id, Number(-outUnits)) // From Acc 2
      .addTokenTransfer(this.tokenId, this.account3Id, Number(in3Units))  // To Acc 3
      .addTokenTransfer(this.tokenId, this.account4Id, Number(in4Units)); // To Acc 4

  // Freeze with payer (Acc 1)
  client.setOperator(this.account1Id, this.account1Key);
  await transferTx.freezeWith(client);
  console.log("Multi-party transaction created and frozen.");

  this.createdTransaction = transferTx; // Store unsigned frozen transaction
});

// --- SINGLE Submit Step ---
// This step takes the transaction stored in `this.createdTransaction`
// determines necessary signatures, signs if needed, sets the payer, and executes.
When(/^The first account submits the transaction$/, async function () {
    assert.ok(this.createdTransaction, "Transaction not found in context for submission");
    assert.ok(this.account1Id && this.account1Key, "Account 1 context not set for submission");

    let transactionToSubmit : Transaction = this.createdTransaction; // Transaction from context
    let payerAccountId = this.account1Id; // Default payer
    let payerKey = this.account1Key;
    let requiresAcc2Sig = false;
    let isRecipientPays = false;

    // --- Determine Signatures & Payer ---

    // Check if recipient-pays: Transaction is already signed, and signer is likely Acc 2
    if (transactionToSubmit.isFrozen() && transactionToSubmit.getSignatures().size > 0 && this.account2Key) {
        const sigMap = transactionToSubmit.getSignatures();
        for (const pubKey of sigMap.keys()) {
            if (pubKey.toString() === this.account2Key.publicKey.toString()) {
                isRecipientPays = true;
                break;
            }
        }
        if(isRecipientPays){
             payerAccountId = this.account1Id; // Acc 1 (recipient) pays
             payerKey = this.account1Key;
             console.log("Recipient-pays scenario detected: Acc 1 will pay, Acc 2 already signed.");
             // Record balance before for fee check
             client.setOperator(payerAccountId, payerKey); // Set operator to get correct balance
             try { this.balanceBefore = (await new AccountBalanceQuery().setAccountId(payerAccountId).execute(client)).hbars; }
             catch { /* ignore if query fails */ } // Best effort balance capture
             console.log(`Account 1 HBAR balance before submit (recipient pays): ${this.balanceBefore?.toString()}`);
        }
    }

    // Check if multi-party requiring Acc 2 signature (and not already signed in recipient-pays)
    if (!isRecipientPays && transactionToSubmit instanceof TransferTransaction && this.account2Id) {
        const transfers = transactionToSubmit.tokenTransfers.get(this.tokenId?.toString() ?? "");
        // Check if Account 2 is sending tokens (amount < 0)
        if (transfers) {
            for (const [accountId, amount] of transfers) {
                if (accountId.equals(this.account2Id as AccountId) && amount.isNegative()) {
                    requiresAcc2Sig = true;
                    break;
                }
            }
        }
    }

    // --- Signing ---
    if (requiresAcc2Sig) {
         assert.ok(this.account2Key, "Account 2 key needed for signing multi-party but not found");
         // Check if already signed by Acc2 (might happen if logic overlaps)
         let acc2AlreadySigned = false;
         const sigMap = transactionToSubmit.getSignatures();
         for (const pubKey of sigMap.keys()) {
             if (pubKey.toString() === this.account2Key.publicKey.toString()) {
                 acc2AlreadySigned = true;
                 break;
             }
         }
         if (!acc2AlreadySigned) {
            console.log("Signing multi-party transaction with Account 2 key...");
            transactionToSubmit = await transactionToSubmit.sign(this.account2Key);
         } else {
             console.log("Multi-party transaction already signed by Account 2.");
         }
    }
    // Account 1 (Payer) signature is handled by .execute() if they are the operator

    // --- Submission ---
    client.setOperator(payerAccountId, payerKey); // Set the PAYER as operator
    console.log(`Account ${payerAccountId.toString()} submitting the transaction...`);

    try {
        // Execute the (potentially now signed) transaction
        const txResponse = await transactionToSubmit.execute(client);
        const receipt = await txResponse.getReceipt(client);
        // Strict check for SUCCESS
        if (receipt.status !== Status.Success) {
             throw new ReceiptStatusError({ 
                status: receipt.status,
                transactionReceipt: receipt,
                transactionId: txResponse.transactionId
             });
        }
        console.log("Transaction submitted and executed successfully.");
    } catch(error) {
         console.error("ERROR during transaction submission/execution:", error);
         // Log receipt status if available
         if (error instanceof ReceiptStatusError) {
             console.error("Receipt Status on Error:", error.status.toString());
         }
         throw error; // Re-throw
    }

    this.createdTransaction = undefined; // Clear context
    await delay(5000); // Wait after submission
});

// --- Fee Verification Step ---
Then(/^The first account has paid for the transaction fee$/, async function () {
    assert.ok(this.account1Id && this.account1Key, "Account 1 context not set for fee check");
    assert.ok(this.balanceBefore !== undefined, "Balance before transaction not recorded for fee check.");

    client.setOperator(this.account1Id, this.account1Key); // Ensure client can query Acc 1
    const balanceAfter = (await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client)).hbars;
    console.log(`Account 1 HBAR balance before fee: ${this.balanceBefore.toString()}, after fee: ${balanceAfter.toString()}`);

    // Use isLessThan for comparison
    assert.ok(balanceAfter.toBigNumber().isLessThan(this.balanceBefore.toBigNumber()), "Account 1 HBAR balance did not decrease after paying fee.");
    console.log("Verified Account 1 HBAR balance decreased (paid fee).");
    this.balanceBefore = undefined; // Clear context
});

// Given('A first hedera account with more than {int} hbar', async function (minHbar: number) {
//   console.log("--- Setting up Account 1 (Given A first...) ---");
//   const acc = getAccount(0);
//   this.account1Id = acc.id;
//   this.account1Key = acc.key;
//   // Also set generic context if needed elsewhere
//   this.account = this.account1Id;
//   this.privKey = this.account1Key;

//   client.setOperator(this.account1Id, this.account1Key);
//   console.log(`Operator set to Account 1: ${this.account1Id.toString()}`);

//   const balance = await new AccountBalanceQuery().setAccountId(this.account1Id).execute(client);
//   console.log(`Account 1 ${this.account1Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
//   assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 1 ${this.account1Id.toString()} needs more than ${minHbar} hbar, but has ${balance.hbars.toString()}`);
// });

Given('A second Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log("--- Setting up Account 2 with Tokens ---");
  // 1. Ensure Account 2 exists
  const acc = getAccount(1);
  this.account2Id = acc.id;
  this.account2Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
       const balance = await new AccountBalanceQuery().setAccountId(this.account2Id).execute(client);
       console.log(`Account 2 ${this.account2Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
        assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 2 needs more than ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 2");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 2 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account2Id, this.account2Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

Given('A third Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log("--- Setting up Account 3 with Tokens ---");
  // 1. Ensure Account 3 exists
  const acc = getAccount(2);
  this.account3Id = acc.id;
  this.account3Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
      const balance = await new AccountBalanceQuery().setAccountId(this.account3Id).execute(client);
      console.log(`Account 3 ${this.account3Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
      assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 3 needs more than ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 3");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 3 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account3Id, this.account3Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});

Given('A fourth Hedera account with {int} hbar and {int} HTT tokens', async function (minHbar: number, balanceTokens: number) {
  console.log("--- Setting up Account 4 with Tokens ---");
  // 1. Ensure Account 4 exists
  const acc = getAccount(3);
  this.account4Id = acc.id;
  this.account4Key = acc.key;
  assert.ok(this.account1Id && this.account1Key, "Account 1 (Payer) context must be set");
  client.setOperator(this.account1Id, this.account1Key); // Acc 1 pays

  // 2. Check HBAR (optional)
  if (minHbar > 0) {
      const balance = await new AccountBalanceQuery().setAccountId(this.account4Id).execute(client);
      console.log(`Account 4 ${this.account4Id.toString()} HBAR balance: ${balance.hbars.toString()}`);
      assert.ok(balance.hbars.toBigNumber().isGreaterThan(minHbar), `Account 4 needs more than ${minHbar} hbar.`);
  }

  // 3. Ensure Token exists
  assert.ok(this.tokenId, "Token ID must be set before setting balance for Account 4");
  assert.ok(this.tokenDecimals !== undefined, "Token decimals must be set");

  // 4. Set token balance (includes association)
  console.log(`Setting initial token balance for Account 4 to ${balanceTokens} HTT`);
  await setTokenBalance(this.account4Id, this.account4Key, this.tokenId, balanceTokens, this.tokenDecimals, client);
});