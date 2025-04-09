import { Given, Then, When } from "@cucumber/cucumber";
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  KeyList,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageQuery,
  TopicMessageSubmitTransaction
} from "@hashgraph/sdk";
import { accounts } from "../../src/config";
import assert from "node:assert";

// Pre-configured client for test network (testnet)
const client = Client.forTestnet();

// Set the operator with the account ID and private key
Given(/^a first account with more than (\d+) hbars$/, async function (expectedBalance: number) {
  const acc = accounts[0];
  const account: AccountId = AccountId.fromString(acc.id);
  this.account = account;
  const privKey: PrivateKey = PrivateKey.fromStringED25519(acc.privateKey);
  this.privKey = privKey;
  client.setOperator(this.account, privKey);

  // Create the query request
  const query = new AccountBalanceQuery().setAccountId(account);
  const balance = await query.execute(client);
  assert.ok(balance.hbars.toBigNumber().toNumber() > expectedBalance);
});

When(/^A topic is created with the memo "([^"]*)" with the first account as the submit key$/, async function (memo: string) {
  const transaction = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setSubmitKey(this.privKey)
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  this.topicId = receipt.topicId;
  assert.ok(this.topicId, "Topic ID should not be null");
});

When(/^The message "([^"]*)" is published to the topic$/, async function (message: string) {
  const transaction = await new TopicMessageSubmitTransaction()
    .setTopicId(this.topicId)
    .setMessage(message)
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  assert.ok(receipt.status.toString() === "SUCCESS", "Message submission failed");
});

Then(/^The message "([^"]*)" is received by the topic and can be printed to the console$/, async function (message: string) {
  const query = new TopicMessageQuery()
    .setTopicId(this.topicId)
    .setStartTime(0);
  
  query.subscribe(client, null, (msg) => {
    const receivedMessage = Buffer.from(msg.contents).toString();
    console.log(`Received message: ${receivedMessage}`);
    assert.strictEqual(receivedMessage, message, "Received message does not match expected message");
  });
});

Given(/^A second account with more than (\d+) hbars$/, async function (expectedBalance: number) {
  const acc = accounts[1];
  const account: AccountId = AccountId.fromString(acc.id);
  this.secondAccount = account;
  const privKey: PrivateKey = PrivateKey.fromStringED25519(acc.privateKey);
  this.secondPrivKey = privKey;

  const query = new AccountBalanceQuery().setAccountId(account);
  const balance = await query.execute(client);
  assert.ok(balance.hbars.toBigNumber().toNumber() > expectedBalance);
});

Given(/^A (\d+) of (\d+) threshold key with the first and second account$/, async function (threshold: number, total: number) {
  const thresholdKey = new KeyList(
    [this.privKey.publicKey, this.secondPrivKey.publicKey],
    threshold
  );
  this.thresholdKey = thresholdKey;
});

When(/^A topic is created with the memo "([^"]*)" with the threshold key as the submit key$/, async function (memo: string) {
  const transaction = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setSubmitKey(this.thresholdKey)
    .execute(client);
  const receipt = await transaction.getReceipt(client);
  this.topicId = receipt.topicId;
  assert.ok(this.topicId, "Topic ID should not be null");
});