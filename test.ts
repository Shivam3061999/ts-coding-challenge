import { Client, PrivateKey, AccountCreateTransaction, Hbar, AccountBalanceQuery } from "@hashgraph/sdk";

async function createAndLogAccount() {
    try {
        // Connect to the Hedera testnet
        const client = Client.forTestnet();

        // Set the operator account ID and private key (replace with your testnet credentials)
        const operatorId = "0.0.5838515"; // Your testnet account ID
        const operatorKey = PrivateKey.fromStringED25519("fa672f146b73f15c930b1cbabebcd4674ba45a5aba24dcbb663817d80778af86"); // Your testnet private key
        client.setOperator(operatorId, operatorKey);

        // Check the balance of the operator account
        const balanceQuery = new AccountBalanceQuery().setAccountId(operatorId);
        const balance = await balanceQuery.execute(client);
        console.log(`Operator account balance: ${balance.hbars.toString()}`);

        if (balance.hbars.toTinybars().toNumber() < 100000000) { // Check if balance is less than 1 hbar
            throw new Error("Insufficient balance in the operator account. Please fund the account.");
        }

        // Generate a new key pair for the new account
        const newPrivateKey = PrivateKey.generateED25519();
        const newPublicKey = newPrivateKey.publicKey;

        // Create a new account with an initial balance
        const transaction = new AccountCreateTransaction()
            .setKey(newPublicKey)
            .setInitialBalance(new Hbar(100)); // Set initial balance in hbars

        const response = await transaction.execute(client);
        const receipt = await response.getReceipt(client);
        const newAccountId = receipt.accountId;

        // Log the new account details
        console.log(`New Account ID: ${newAccountId?.toString()}`);
        console.log(`New Private Key: ${newPrivateKey.toString()}`);
        console.log(`New Public Key: ${newPublicKey.toString()}`);
    } catch (error) {
        console.error("Error creating account:", error);
    }
}

// Call the function to create and log the account
createAndLogAccount();