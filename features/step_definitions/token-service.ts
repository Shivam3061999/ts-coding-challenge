import { Given, Then, When } from "@cucumber/cucumber";
import { accounts } from "../../src/config";
import {
    AccountBalanceQuery,
    AccountId,
    Client,
    PrivateKey,
    TokenCreateTransaction,
    TransferTransaction,
    TokenInfoQuery,
    TokenMintTransaction,
    TokenSupplyType,
    TokenType,
    Hbar,
    TokenAssociateTransaction
} from "@hashgraph/sdk";
import assert from "node:assert";

const client = Client.forTestnet();

const firstAccount = accounts[0];
const firstAccountId = AccountId.fromString(firstAccount.id);
const firstPrivateKey = PrivateKey.fromStringED25519(firstAccount.privateKey);

const secondAccountId = AccountId.fromString(accounts[1].id);
const secondPrivateKey = PrivateKey.fromStringED25519(accounts[1].privateKey);

const thirdAccountId = AccountId.fromString(accounts[2].id);
const thirdPrivateKey = PrivateKey.fromStringED25519(accounts[2].privateKey);

const fourthAccountId = AccountId.fromString(accounts[3].id);
const fourthPrivateKey = PrivateKey.fromStringED25519(accounts[3].privateKey);

let tokenId: string;
let tokenDecimals: number;

client.setOperator(firstAccountId, firstPrivateKey);

async function createFungibleToken(initialSupply = 0, supplyType = TokenSupplyType.Infinite) {
    const transaction = await new TokenCreateTransaction()
        .setTokenName("Test Token")
        .setTokenSymbol("HTT")
        .setDecimals(2)
        .setInitialSupply(initialSupply)
        .setTreasuryAccountId(firstAccountId)
        .setSupplyType(supplyType)
        .setTokenType(TokenType.FungibleCommon)
        .setSupplyKey(firstPrivateKey)
        .freezeWith(client);

    const signedTx = await transaction.sign(firstPrivateKey);
    const response = await signedTx.execute(client);
    const receipt = await response.getReceipt(client);

    if (!receipt.tokenId) {
        throw new Error("Token ID is undefined");
    }
    tokenId = receipt.tokenId.toString();
    tokenDecimals = 2;
}

async function createFixedSupplyToken(initialSupply: number) {
    const transaction = await new TokenCreateTransaction()
        .setTokenName("Test Token")
        .setTokenSymbol("HTT")
        .setDecimals(2)
        .setInitialSupply(initialSupply)
        .setTreasuryAccountId(firstAccountId)
        .setSupplyType(TokenSupplyType.Finite)
        .setMaxSupply(initialSupply)
        .setTokenType(TokenType.FungibleCommon)
        .freezeWith(client);

    const signedTx = await transaction.sign(firstPrivateKey);
    const response = await signedTx.execute(client);
    const receipt = await response.getReceipt(client);

    if (!receipt.tokenId) {
        throw new Error("Token ID is undefined");
    }
    tokenId = receipt.tokenId.toString();
    tokenDecimals = 2;
}

async function associateToken(accountId: AccountId, privateKey: PrivateKey, tokenId: string) {
    const transaction = await new TokenAssociateTransaction()
        .setAccountId(accountId)
        .setTokenIds([tokenId])
        .freezeWith(client);
    
    const signedTx = await transaction.sign(privateKey);
    const response = await signedTx.execute(client);
    await response.getReceipt(client);
}

Given(/^A Hedera account with more than (\d+) hbar$/, async function (expectedBalance: number) {
      const balance = await new AccountBalanceQuery()
      .setAccountId(firstAccountId)
      .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() > expectedBalance);
});

When(/^I create a token named Test Token \(HTT\)$/, async function () {
    await createFungibleToken();
    this.tokenId = tokenId;
});
Then(/^The token has the name "([^"]*)"$/, async function (expectedName: string) {
    const tokenInfo = await new TokenInfoQuery()
        .setTokenId(this.tokenId)
        .execute(client);
    assert.strictEqual(tokenInfo.name, expectedName);
});

Then(/^The token has the symbol "([^"]*)"$/, async function (expectedSymbol: string) {
    const tokenInfo = await new TokenInfoQuery()
        .setTokenId(this.tokenId)
        .execute(client);
    assert.strictEqual(tokenInfo.symbol, expectedSymbol);
});

Then(/^The token has (\d+) decimals$/, async function (expectedDecimals: number) {
    const tokenInfo = await new TokenInfoQuery()
        .setTokenId(this.tokenId)
        .execute(client);
    assert.strictEqual(tokenInfo.decimals, expectedDecimals);
});

Then(/^The token is owned by the account$/, async function () {
    const tokenInfo = await new TokenInfoQuery()
        .setTokenId(this.tokenId)
        .execute(client);
    assert.ok(tokenInfo.treasuryAccountId);
    assert.strictEqual(tokenInfo.treasuryAccountId.toString(), firstAccountId.toString());
});

Then(/^An attempt to mint (\d+) additional tokens succeeds$/, async function (amount: number) {
    const transaction = await new TokenMintTransaction()
        .setTokenId(this.tokenId)
        .setAmount(amount)
        .freezeWith(client);

    const signedTx = await transaction.sign(firstPrivateKey);
    const response = await signedTx.execute(client);
    const receipt = await response.getReceipt(client);
    assert.strictEqual(receipt.status.toString(), "SUCCESS");
});

When(/^I create a fixed supply token named Test Token \(HTT\) with (\d+) tokens$/, async function (initialSupply: number) {
    await createFixedSupplyToken(initialSupply);
    this.tokenId = tokenId;
});

Then(/^The total supply of the token is (\d+)$/, async function (expectedSupply: number) {
    const tokenInfo = await new TokenInfoQuery()
        .setTokenId(this.tokenId)
        .execute(client);
    assert.strictEqual(tokenInfo.totalSupply.toString(), expectedSupply.toString());
});

Then(/^An attempt to mint tokens fails$/, async function () {
    try {
        const transaction = await new TokenMintTransaction()
            .setTokenId(this.tokenId)
            .setAmount(1)
            .execute(client);
        await transaction.getReceipt(client);
        assert.fail("Minting should have failed");
    } catch (err: any) {
        assert.ok(err.toString().includes("TOKEN_HAS_NO_SUPPLY_KEY"));
    }
});

Given(/^A first hedera account with more than (\d+) hbar$/, async function (expectedBalance: number) {
    const balance = await new AccountBalanceQuery()
        .setAccountId(firstAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() > expectedBalance);
});

Given(/^A second Hedera account$/, async function () {
    const balance = await new AccountBalanceQuery()
        .setAccountId(secondAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() > 0);
});

Given(/^A token named Test Token \(HTT\) with (\d+) tokens$/, async function (initialSupply: number) {
    await createFungibleToken(initialSupply);
    this.tokenId = tokenId;
});

Given(/^The first account holds (\d+) HTT tokens$/, async function (expectedBalance: number) {
    const balance = await new AccountBalanceQuery()
        .setAccountId(firstAccountId)
        .execute(client);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedBalance);
});

Given(/^The second account holds (\d+) HTT tokens$/, async function (expectedBalance: number) {
    try {
        await associateToken(secondAccountId, secondPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const balance = await new AccountBalanceQuery()
        .setAccountId(secondAccountId)
        .execute(client);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedBalance);
});

When(/^The first account creates a transaction to transfer (\d+) HTT tokens to the second account$/, async function (amount: number) {
    try {
        await associateToken(secondAccountId, secondPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const transaction = await new TransferTransaction()
        .addTokenTransfer(this.tokenId, firstAccountId, -amount)
        .addTokenTransfer(this.tokenId, secondAccountId, amount)
        .freezeWith(client);
    const signedTx = await transaction.sign(firstPrivateKey);
    const response = await signedTx.execute(client);
    this.receipt = await response.getReceipt(client);
});

When(/^The first account submits the transaction$/, async function () {
    assert.strictEqual(this.receipt.status.toString(), "SUCCESS");
});

When(/^The second account creates a transaction to transfer (\d+) HTT tokens to the first account$/, async function (amount: number) {
    try {
        await associateToken(secondAccountId, secondPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const transaction = await new TransferTransaction()
        .addTokenTransfer(this.tokenId, secondAccountId, -amount)
        .addTokenTransfer(this.tokenId, firstAccountId, amount)
        .freezeWith(client);
    const signedTx = await transaction.sign(secondPrivateKey);
    const response = await signedTx.execute(client);
    this.receipt = await response.getReceipt(client);
});

Then(/^The first account has paid for the transaction fee$/, async function () {
    const balance = await new AccountBalanceQuery()
        .setAccountId(firstAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() > 0);
});

Given(/^A first hedera account with more than (\d+) hbar and (\d+) HTT tokens$/, async function (expectedHbar: number, expectedTokens: number) {
    try {
        await associateToken(firstAccountId, firstPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const balance = await new AccountBalanceQuery()
        .setAccountId(firstAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() > expectedHbar);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedTokens);
});

Given(/^A second Hedera account with (\d+) hbar and (\d+) HTT tokens$/, async function (expectedHbar: number, expectedTokens: number) {
    try {
        await associateToken(secondAccountId, secondPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const balance = await new AccountBalanceQuery()
        .setAccountId(secondAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() >= expectedHbar);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedTokens);
});

Given(/^A third Hedera account with (\d+) hbar and (\d+) HTT tokens$/, async function (expectedHbar: number, expectedTokens: number) {
    try {
        await associateToken(thirdAccountId, thirdPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const balance = await new AccountBalanceQuery()
        .setAccountId(thirdAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() >= expectedHbar);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedTokens);
});

Given(/^A fourth Hedera account with (\d+) hbar and (\d+) HTT tokens$/, async function (expectedHbar: number, expectedTokens: number) {
    try {
        await associateToken(fourthAccountId, fourthPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const balance = await new AccountBalanceQuery()
        .setAccountId(fourthAccountId)
        .execute(client);
    assert.ok(balance.hbars.toBigNumber().toNumber() >= expectedHbar);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedTokens);
});

When(/^A transaction is created to transfer (\d+) HTT tokens out of the first and second account and (\d+) HTT tokens into the third account and (\d+) HTT tokens into the fourth account$/, async function (amount1: number, amount2: number, amount3: number) {
    // Create a single atomic transaction for all transfers
    try {
        await associateToken(firstAccountId, firstPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    try {
        await associateToken(secondAccountId, secondPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    try {
        await associateToken(thirdAccountId, thirdPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    try {
        await associateToken(fourthAccountId, fourthPrivateKey, tokenId);
    } catch (err: any) {
        if (!err.toString().includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) {
            throw err;
        }
    }
    const transaction = await new TransferTransaction()
        .addTokenTransfer(this.tokenId, firstAccountId, -amount1)
        .addTokenTransfer(this.tokenId, secondAccountId, -amount1)
        .addTokenTransfer(this.tokenId, thirdAccountId, amount2)
        .addTokenTransfer(this.tokenId, fourthAccountId, amount3)
        .freezeWith(client);

    // Sign with both required private keys
    const signedTx = await (await transaction.sign(firstPrivateKey)).sign(secondPrivateKey);
    const response = await signedTx.execute(client);
    this.receipt = await response.getReceipt(client);
    assert.strictEqual(this.receipt.status.toString(), "SUCCESS");
});

Then(/^The third account holds (\d+) HTT tokens$/, async function (expectedBalance: number) {
    const balance = await new AccountBalanceQuery()
        .setAccountId(thirdAccountId)
        .execute(client);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedBalance);
});

Then(/^The fourth account holds (\d+) HTT tokens$/, async function (expectedBalance: number) {
    const balance = await new AccountBalanceQuery()
        .setAccountId(fourthAccountId)
        .execute(client);
    const tokenBalance = balance.tokens?.get(this.tokenId);
    assert.ok(tokenBalance);
    assert.strictEqual(tokenBalance.toNumber(), expectedBalance);
});
