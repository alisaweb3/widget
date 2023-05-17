import { defineStore } from 'pinia';
import { Coin } from '../../utils/type';

import { WalletName } from '../../../lib/wallet/Wallet';
import { UniClient } from '../../../lib/wallet/UniClient';
import { getBalance, getLatestBlock } from '../../utils/http';

export const useTxDialog = defineStore('ping-tx-dialog', {
  state: () => {
    return {
        // component variables
        txType: "",
        chainId: "cosmoshub-4",
        sender: "",
        endpoint: "",
        params: {} as Record<string, any>,

        // account variables
        account: {} as { account_number: string; sequence: string },
        balances: [] as Coin[],

        // msg variables
        gas: "",
        feeAmount: 2000,
        feeDenom: "",
        memo: "Ping.pub"
    };
  },
  getters: {},
  actions: {
    initial(
        txType?: string,
        endpoint?: string,
        sender?: string,
        params?: string) {
        this.txType = txType
        this.endpoint = endpoint
        this.sender = sender
        this.params = JSON.parse(params || "{}")
        if(endpoint) {
            if(sender) getBalance(endpoint, sender).then((x) => {
                this.balances = x.balances;
                this.balances.forEach(bal => {
                    console.log(bal.denom)
                });
            });
            getLatestBlock(endpoint).then((x) => {
                this.chainId = x.block.header.chain_id;
            });
        }
    },
    async sendTx(messages: any[]) {

        // const acc = await getAccount(props.endpoint, props.sender);
        // const messages = msgBox.value.msgs;

        const tx = {
            chainId: this.chainId,
            signerAddress: this.sender,
            messages,
            fee: {
                gas: String(gasInfo.value),
                amount: [{ amount: String(fees.value), denom: feeDenom.value }],
            },
            memo: memo.value,
            signerData: {
                accountNumber: Number(acc.account.account_number),
                sequence: Number(acc.account.sequence),
                chainId: chainId.value,
            },
        };
        console.log('tx:', tx);

        try {
            const client = new UniClient(WalletName.Keplr, {
                chainId: chainId.value,
            });

            //   console.log("gasInfo:", gasInfo)
            const txRaw = await client.sign(tx);
            const response = await client.broadcastTx(props.endpoint, txRaw);
            // show submitting view
            view.value = 'submitting';

            console.log('broadcast:', response);
            setTimeout(() => (open.value = false), 6000);
        } catch (e) {
            console.error(e);
            sending.value = false;
            error.value = e;
            setTimeout(() => (error.value = ''), 5000);
        }
    }
  },
});
