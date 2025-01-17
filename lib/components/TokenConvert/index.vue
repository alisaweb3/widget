<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { fromBech32, toBech32, toHex } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';
import ChainRegistryClient from '@ping-pub/chain-registry-client';
import {
    Asset,
    Chain,
    IBCInfo,
    IBCPath,
} from '@ping-pub/chain-registry-client/dist/types';
import { getBalance, getStakingParam, getOsmosisPools, getLatestBlock, getAccount } from '../../utils/http';
import { ConnectedWallet, WalletName } from '../../wallet/Wallet';
import { Coin } from '../../utils/type';
import { osmosis, ibc, getSigningOsmosisClient } from 'osmojs';
import { tokens, type TokenConfig } from './tokens';
import { decimal2percent } from '../../utils/format';
import { StdFee, coin } from '@cosmjs/stargate';
import { longify } from '@cosmjs/stargate/build/queryclient';
import Long from 'long';
import dayjs from 'dayjs';
import { UniClient } from '../../wallet/UniClient';

const props = defineProps({
    chainName: { type: String, required: true },
    endpoint: { type: String, required: true },
    hdPath: String,
});
const OSMOSIS_RPC = 'https://rpc.osmosis.zone';
const OSMOSIS_REST = 'https://lcd.osmosis.zone';
const DEFAULT_HDPATH = "m/44'/118/0'/0/0";

const view = ref("swap") // [swap, deposit, withdraw]

function switchView(v: string) {
    view.value = v
}

// variables
const direction = ref('buy');
const sending = ref(false);
const open = ref(false);
const error = ref('');
const chains = ref([] as IBCPath[]);
const osmosisPath = ref({} as IBCPath | undefined);
const osmosisPathInfo = ref({} as IBCInfo);
const defaultDenom = ref('');
const sender = ref({} as ConnectedWallet);
const localBalances = ref([] as Coin[]);
const osmoBalances = ref([] as Coin[]);
const localCoinInfo = ref([] as Asset[]);
const swapIn = ref({} as TokenConfig | undefined);
const swapOut = ref({} as TokenConfig | undefined);
const amountIn = ref("");
const allPools = ref([] as any[]);
const client = new ChainRegistryClient();
const localChainInfo = ref({} as Chain);

// swap logic

async function initData() {
    sender.value = JSON.parse(
        localStorage.getItem(props.hdPath || DEFAULT_HDPATH) || '{}'
    ) as ConnectedWallet;
    if (sender.value.cosmosAddress && open.value ) {
        await getBalance(OSMOSIS_REST, osmoAddress(sender.value.cosmosAddress)).then(
            (res) => {
                osmoBalances.value = res.balances.filter(
                    (x) => !x.denom.startsWith('gamm')
                );
            })
        await getBalance(props.endpoint, localAddress(sender.value.cosmosAddress)).then(
            (res) => {
                localBalances.value = res.balances;
            }
        );
    }
}

function osmoAddress(addr?: string) {
    if(!addr) return ""
    const { data } = fromBech32(addr);
    return toBech32('osmo', data);
}

function localAddress(addr?: string) {
    if(!addr) return ""
    const { data } = fromBech32(addr);
    const prefix = localChainInfo.value?.bech32_prefix || "cosmos"
    return toBech32(prefix, data);
}

getStakingParam(props.endpoint).then((x) => {
    defaultDenom.value = x.params.bond_denom;
});
getOsmosisPools(OSMOSIS_REST).then((res) => {
    allPools.value = res.pools;
});

client.fetchChainInfo(props.chainName).then(res => {
    localChainInfo.value = res
})

client.fetchIBCPaths().then((paths) => {
    chains.value = paths.filter(
        (x) => x.from === props.chainName || x.to === props.chainName
    );
    const path = chains.value.find(
        (x) => x.from === 'osmosis' || x.to === 'osmosis'
    );
    if (path) {
        osmosisPath.value = path;
        client.fetchIBCPathInfo(path.path).then((info) => {
            osmosisPathInfo.value = info;
        });
    }
    client.fetchAssetsList(props.chainName).then((al) => {
        localCoinInfo.value = al.assets;
    });
});

function showBalance(denom?: string, decimal = 0) {
    const bal = osmoBalances.value.find((x) => x.denom === denom || '');
    if (bal) {
        return Number(bal.amount) / 10 ** decimal;
    }
    return 0;
}

function findlocalCoinDecimal(denom: string) {
    const localCoin = localCoinInfo.value.find((x) => x.base === denom);
    if (localCoin) {
        const unit = localCoin.denom_units.find(
            (x) => x.denom === localCoin.symbol.toLowerCase()
        );
        if (unit) return unit.exponent;
    }
    return 0;
}

function findTokenUrl(coinInfo?: Asset) {
    const url =
        coinInfo?.logo_URIs?.svg ||
        coinInfo?.logo_URIs?.png ||
        coinInfo?.logo_URIs?.jpeg;
    return url
        ? url.replace(
              'https://raw.githubusercontent.com/cosmos/chain-registry/master',
              'https://registry.ping.pub'
          )
        : '';
}

const localTokenOnOsmosis = computed(() => {
    const channel = osmosisPathInfo.value.channels?.find(
        (x) => x.chain_1.port_id === 'transfer'
    );
    const channelId =
        osmosisPathInfo.value.chain_1?.chain_name === 'osmosis'
            ? channel?.chain_1.channel_id
            : channel?.chain_2.channel_id;
    const ibcDenom = toHex(
        sha256(
            new TextEncoder().encode(
                `transfer/${channelId}/${defaultDenom.value}`
            )
        )
    ).toUpperCase();
    const localCoin = localCoinInfo.value?.find(
        (x) => x.base === defaultDenom.value
    );
    return [
        {
            denom: defaultDenom.value,
            symbol: localCoin?.symbol || '',
            ibcDenom: `ibc/${ibcDenom}`,
            sourceChannelId: channelId,
            decimals: findlocalCoinDecimal(defaultDenom.value),
            coinImageUrl: findTokenUrl(localCoin),
        },
    ];
});

const localSourceChannelID = computed(() => {
    const channel = osmosisPathInfo.value.channels?.find(
        (x) => x.chain_1.port_id === 'transfer'
    );
    const channelId =
        osmosisPathInfo.value.chain_1?.chain_name === 'osmosis'
            ? channel?.chain_2.channel_id
            : channel?.chain_1.channel_id;
    return channelId
});

const withdrawable = computed(() => {
    return localTokenOnOsmosis.value.findIndex(x => x.denom === swapOut.value?.denom) > -1
})

const depositable = computed(() => {
    return localTokenOnOsmosis.value.findIndex(x => x.denom === swapIn.value?.denom) > -1
})

const inTokens = computed(() => {
    if (direction.value === 'buy') {
        swapIn.value = tokens[0];
        return tokens;
    } else {
        swapIn.value = localTokenOnOsmosis.value[0];
        return localTokenOnOsmosis.value;
    }
});

const outTokens = computed(() => {
    if (direction.value === 'buy') {
        swapOut.value = localTokenOnOsmosis.value[0];
        return localTokenOnOsmosis.value;
    } else {
        swapOut.value = tokens[0];
        return tokens;
    }
});

const pool = computed(() => {
    // find the available pools and sort by liquidity depth
    const a = allPools.value
        .filter(
            (x) =>
                x.pool_assets?.findIndex(
                    (a) => a.token.denom === swapIn.value?.ibcDenom
                ) > -1
        )
        .filter(
            (x) =>
                x.pool_assets?.findIndex(
                    (a) => a.token.denom === swapOut.value?.ibcDenom
                ) > -1
        )
        .sort(
            (a, b) =>
                Number(b.total_shares.amount) - Number(a.total_shares.amount)
        );
    // console.log(a)
    return a.length > 0 ? a[0] : null;
});

function switchDirection() {
    direction.value = direction.value === 'buy' ? 'sell' : 'buy';
}

const disabled = computed(() => {
    const amount = Number(amountIn.value || 0)
    if(amount <= 0 ) return true
    const token = swapIn.value
    const b = osmoBalances.value.find((x) => x.denom === token?.ibcDenom || '');
    if(b && token) {
        return Number(b.amount) < amount * (10 ** token.decimals)
    }
    return true
})

const outAmount = computed(() => {
    // tokenBalanceOut * [1 - { tokenBalanceIn / (tokenBalanceIn + (1 - swapFee) * tokenAmountIn)} ^ (tokenWeightIn / tokenWeightOut)]
    const p = pool.value;
    if (p) {
        const tokenBalanceOut = p.pool_assets?.find(
            (x) => x.token.denom === swapOut.value?.ibcDenom
        );
        const tokenBalanceIn = p.pool_assets?.find(
            (x) => x.token.denom === swapIn.value?.ibcDenom
        );
        if (tokenBalanceIn && tokenBalanceOut) {
            const balanceOut = Number(tokenBalanceOut.token.amount);
            const balanceIn = Number(tokenBalanceIn.token.amount);
            const weightOut = Number(tokenBalanceOut.weight);
            const weightIn = Number(tokenBalanceIn.weight);
            const swapFee = Number(p.pool_params.swap_fee);
            const amount = Number(amountIn.value) * (1 - swapFee);
            const out =
                balanceOut *
                (1 -
                    balanceIn / (balanceIn + amount) ** (weightIn / weightOut));
            return out;
        }
    }
    return 0;
});

async function doSwap() {
    sending.value = true
    const latest = await getLatestBlock(OSMOSIS_REST)

    const stargateClient = await getSigningOsmosisClient({
        rpcEndpoint: OSMOSIS_RPC,
        signer: window.getOfflineSigner(latest.block.header.chain_id)
    })
    const address = osmoAddress(sender.value.cosmosAddress)

    if(!swapIn.value || !swapOut.value || !address) return
    const { swapExactAmountIn } = osmosis.gamm.v1beta1.MessageComposer.withTypeUrl;

    
    const amount = Number(amountIn.value || 0)
    const msg = swapExactAmountIn({
        sender: address,
        routes: [{
            poolId: Long.fromNumber(pool.value.id), 
            tokenOutDenom: swapOut.value.ibcDenom
        }],
        tokenIn: {
            amount: (amount * 10 ** swapIn.value.decimals).toFixed(),
            denom: swapIn.value.ibcDenom 
        },
        tokenOutMinAmount: ((outAmount.value * 0.99) * 10 ** swapOut.value.decimals).toFixed() // slippage: 1% 
    });

    const gas = await stargateClient.simulate(address, [msg], "")

    const fee: StdFee = {
        amount: [
        {
            denom: 'uosmo',
            amount: '864'
        }
        ],
        gas: (gas * 1.25).toFixed()
    };
    const response = await stargateClient.signAndBroadcast(address, [msg], fee, "Convert on ping.pub");
    console.log(response.code)
    if(response.code === 0) {
        await getBalance(OSMOSIS_REST, osmoAddress(sender.value.cosmosAddress)).then(
            (res) => {
                osmoBalances.value = res.balances.filter(
                    (x) => !x.denom.startsWith('gamm')
                );
            })
    } else {
        if(response.rawLog) error.value = response.rawLog
    }
    sending.value = false
}

// deposit logic
const depositAmount = ref("")

function showLocalBalance(denom = "", decimals = 0) {
    const b = localBalances.value?.find(x => x.denom === denom)
    if(b){
        return Number(b.amount) / 10 ** decimals
    }
    return 0
}
const disableDeposit = computed(() => {
    const token = swapIn.value
    if(token) {
        const b = localBalances.value?.find(x => x.denom === token.denom)
        if(b){
            const amount = Number(depositAmount.value || 0)
            return amount <=0 || Number(b.amount) < amount * 10 ** token.decimals
        }
    }
    return true
})

async function doDeposit() {
    sending.value = true

    const address = localAddress(sender.value.cosmosAddress)

    if(!swapIn.value || !address) return

    const latest = await getLatestBlock(props.endpoint)
    const acc = await getAccount(props.endpoint, address)

    const chainId = latest.block.header.chain_id
    const timeout = Date.now() + new Date().getTimezoneOffset() + 3600000
    const amount = Number(depositAmount.value || 0) * 10 ** swapIn.value.decimals
    const tx = {
        chainId,
        signerAddress: address,
        messages: [{
            typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
            value: {
                sourcePort: 'transfer',
                sourceChannel: localSourceChannelID.value || "",
                token: {
                    amount: String(amount),
                    denom: swapIn.value.denom
                },
                sender: address,
                receiver: osmoAddress(address),
                timeoutTimestamp: `${timeout}000000`,
            },
        }],
        fee: {
            gas: '200000',
            amount: [{ amount: "5000", denom: swapIn.value.denom }],
        },
        memo: "",
        signerData: {
            accountNumber: Number(acc.account.account_number),
            sequence: Number(acc.account.sequence),
            chainId: chainId.value,
        },
    };

    try {
        const client = new UniClient(WalletName.Keplr, {chainId,});

        //   console.log("gasInfo:", gasInfo)
        const txRaw = await client.sign(tx);
        const response = await client.broadcastTx(props.endpoint, txRaw);
        if(response.code === 0) {
            setTimeout(async () => {
                await getBalance(OSMOSIS_REST, osmoAddress(sender.value.cosmosAddress)).then(
                (res) => {
                    osmoBalances.value = res.balances.filter(
                        (x) => !x.denom.startsWith('gamm')
                    );
                })
                await getBalance(props.endpoint, localAddress(sender.value.cosmosAddress)).then(
                    (res) => {
                        localBalances.value = res.balances;
                    }
                );
            }, 6000);
        }
    } catch (e) {
        sending.value = false;
        error.value = e;
        setTimeout(() => (error.value = ''), 5000);
    }
    sending.value = false
}

// withdraw logic
const withdrawAmount = ref("")
const disableWithdraw = computed(() => {
    const token = swapOut.value
    if(token) {
        const b = osmoBalances.value?.find(x => x.denom === token.ibcDenom)
        if(b){
            const amount = Number(withdrawAmount.value || 0)
            return amount <=0 || Number(b.amount) < amount * 10 ** token.decimals
        }
    }
    return true
})
async function doWithdraw() {
    sending.value = true
    const latest = await getLatestBlock(OSMOSIS_REST)

    const stargateClient = await getSigningOsmosisClient({
        rpcEndpoint: OSMOSIS_RPC,
        signer: window.getOfflineSigner(latest.block.header.chain_id)
    })
    const address = osmoAddress(sender.value.cosmosAddress)

    if(!swapIn.value || !swapOut.value || !address) return

    const timeout = Date.now() + new Date().getTimezoneOffset() + 3600000
    const amount = Number(withdrawAmount.value || 0)
    const { transfer } = ibc.applications.transfer.v1.MessageComposer.withTypeUrl
    const msg = transfer({
        sender: address,
        sourceChannel: swapOut.value.sourceChannelId || "",
        sourcePort: 'transfer',
        token: {
            amount: (amount * 10 ** swapOut.value.decimals).toFixed(),
            denom: swapOut.value.ibcDenom
        },
        receiver: localAddress(sender.value.cosmosAddress),
        timeoutTimestamp: Long.fromString(`${timeout}000000`),
        timeoutHeight: {
            revisionHeight: Long.fromNumber(0),
            revisionNumber: Long.fromNumber(0),
        },
        memo: ''
    });

    const gas = await stargateClient.simulate(address, [msg], "")

    const fee: StdFee = {
        amount: [
        {
            denom: 'uosmo',
            amount: '1864'
        }
        ],
        gas: (gas * 1.25).toFixed()
    };
    const response = await stargateClient.signAndBroadcast(address, [msg], fee, "Convert on ping.pub");
    if(response.code === 0) {
        await getBalance(OSMOSIS_REST, osmoAddress(sender.value.cosmosAddress)).then(
            (res) => {
                osmoBalances.value = res.balances.filter(
                    (x) => !x.denom.startsWith('gamm')
                );
            })
        await getBalance(props.endpoint, localAddress(sender.value.cosmosAddress)).then(
            (res) => {
                localBalances.value = res.balances;
            }
        );
    } else {
        if(response.rawLog) error.value = response.rawLog
    }
    sending.value = false
}

</script>
<template>
    <div>
        <!-- modal content -->
        <input
            v-model="open"
            type="checkbox"
            id="PingTokenConvert"
            class="modal-toggle"
            @change="initData()"
        />

        <label for="PingTokenConvert" class="modal cursor-pointer">
            <label class="modal-box dark:bg-[#2a2a3a] relative rounded-lg" for="">
                <div :class="view !== 'swap'?'hidden':''">
                    <h3 class="text-xl font-semibold">Token Convert</h3>
                    <div v-if="!osmosisPath" class="text-error mt-3">
                        <span>Not available for chain [{{ chainName }}]</span>
                    </div>
                    <div
                        class="flex items-center relative h-14 bg-gray-100 dark:bg-[#232333] rounded-tl-lg rounded-tr-lg mt-4"
                    >
                        <div class="dropdown">
                            <label
                                tabindex="0"
                                class="flex items-center h-12 px-4 cursor-pointer"
                            >
                                <img
                                    :src="swapIn?.coinImageUrl"
                                    class="w-8 h-8 mr-3 rounded-full"
                                />
                                <div class="text-lg font-semibold mr-2">
                                    {{ swapIn?.symbol }}
                                </div>
                                <Icon icon="mdi:chevron-down" class="text-lg" />
                            </label>
                            <div
                                tabindex="0"
                                class="dropdown-content shadow bg-base-100 rounded-lg w-64"
                            >
                                <div class="py-2">
                                    <div
                                        v-for="(item, index) in inTokens"
                                        :key="index"
                                        class="flex items-center px-4 py-2 hover:bg-gray-200 dark:hover:bg-[#232333] cursor-pointer"
                                        @click="swapIn = item"
                                    >
                                        <img
                                            class="w-7 h-7 rounded-full mr-2"
                                            :src="item.coinImageUrl"
                                        />
                                        <div class="flex-1 text-sm">
                                            {{ item.symbol }}
                                        </div>
                                        <div
                                            class="text-sm font-semibold text-gray-600"
                                        >
                                            {{
                                                showBalance(
                                                    item.ibcDenom || item.denom,
                                                    item.decimals
                                                )
                                            }}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <input
                            v-model="amountIn"
                            type="number"
                            placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold"
                        />
                    </div>

                    <div
                        class="flex items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-bl-lg rounded-br-lg"
                    >
                        <div class="mr-3 text-sm">Balance:</div>
                        <div class="text-base font-semibold">
                            {{ showBalance(swapIn?.ibcDenom, swapIn?.decimals) }}
                        </div>
                        <Icon v-if="depositable" icon="mdi:plus-box-outline" class="ml-2" @click="switchView('deposit')"/>
                    </div>

                    <!-- switch btn -->
                    <div class="flex items-center justify-center -mt-3 -mb-3">
                        <div
                            class="inline-block px-4 cursor-pointer"
                            @click="switchDirection"
                        >
                            <Icon
                                icon="mdi:arrow-down-circle"
                                color="#676cf6"
                                class="text-4xl dark:bg-gray-50 rounded-full"
                            />
                        </div>
                    </div>

                    <div
                        class="flex items-center h-14 rounded-tl-lg rounded-tr-lg bg-gray-100 dark:bg-[#232333]"
                    >
                        <div class="dropdown">
                            <label
                                tabindex="0"
                                class="flex items-center h-12 px-4 cursor-pointer"
                            >
                                <img
                                    :src="swapOut?.coinImageUrl"
                                    class="w-8 h-8 mr-3 rounded-full"
                                />
                                <div class="text-lg font-semibold mr-2">
                                    {{ swapOut?.symbol }}
                                </div>
                                <Icon icon="mdi:chevron-down" class="text-lg" />
                            </label>
                            <div
                                tabindex="0"
                                class="compact dropdown-content shadow bg-base-100 w-64 rounded-lg"
                            >
                                <div class="py-2">
                                    <div
                                        v-for="(item, index) in outTokens"
                                        :key="index"
                                        @click="swapOut = item"
                                        class="flex items-center px-4 py-2 hover:bg-gray-200 dark:hover:bg-[#232333] cursor-pointer"
                                    >
                                        <img
                                            class="w-7 h-7 rounded-full mr-2"
                                            :src="item.coinImageUrl"
                                        />
                                        <div class="flex-1 text-sm">
                                            {{ item.symbol }}
                                        </div>
                                        <div
                                            class="text-sm font-semibold text-gray-600"
                                        >
                                            {{
                                                showBalance(
                                                    item.ibcDenom || item.denom,
                                                    item.decimals
                                                )
                                            }}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div
                            class="flex-1 w-0 text-xl text-right font-semibold text-gray-600 dark:text-gray-50 pr-4"
                        >
                            {{ `≈ ${parseFloat(outAmount.toFixed(6))}` }}
                        </div>
                    </div>

                    <div
                        class="flex items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-bl-lg rounded-br-lg"
                    >
                        <div class="mr-3 text-sm dark:text-gray-400">Balance:</div>
                        <div class="text-base font-semibold dark:text-gray-200">
                            {{ showBalance(swapOut?.ibcDenom, swapOut?.decimals) }}
                        </div>
                        <Icon v-if="withdrawable" icon="mdi:minus-box-outline" class="ml-2" @click="switchView('withdraw')"/>
                    </div>

                    <div class="px-4 mt-4">
                        <div class="flex items-center justify-between">
                            <div class="text-sm text-gray-600 dark:text-gray-400">
                                Swap Fee
                            </div>
                            <div class="text-base text-gray-800 dark:text-gray-200">
                                {{ decimal2percent(pool?.pool_params.swap_fee) }}%
                            </div>
                        </div>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5">
                        <button
                            class="btn btn-primary w-full ping-connect-confirm capitalize text-base"
                            :class="sending ? 'loading' : ''"
                            :disabled="disabled"
                            @click="doSwap"
                        >
                            Convert
                        </button>
                    </div>
                </div>
                <!-- deposit -->
                <div :class="view !== 'deposit'?'hidden':''">
                    <h3 class="text-xl font-semibold flex"><Icon class="mt-1" icon="mdi:chevron-left" @click="switchView('swap')"></Icon> Deposit</h3>

                    <div class="form-control">
                        <label class="label">
                            <span class="label-text">Recipient</span>
                        </label>
                        <input :value="osmoAddress(sender.cosmosAddress)" readonly type="text" class="input input-bordered" />
                    </div>
                    <div
                        class="flex items-center relative h-14 bg-gray-100 dark:bg-[#232333] rounded-tl-lg rounded-tr-lg mt-4"
                    >
                        <label
                            tabindex="0"
                            class="flex items-center h-12 px-4 cursor-pointer"
                        >
                            <img
                                :src="swapIn?.coinImageUrl"
                                class="w-8 h-8 mr-3 rounded-full"
                            />
                            <div class="text-lg font-semibold mr-2">
                                {{ swapIn?.symbol }}
                            </div>
                        </label>
                        <input
                            v-model="depositAmount"
                            type="number"
                            placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold"
                        />
                    </div>

                    <div
                        class="flex flex-row-reverse items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-bl-lg rounded-br-lg"
                    >
                        <div class="text-base font-semibold">
                            {{ showLocalBalance(swapIn?.denom, swapIn?.decimals) }}
                        </div>
                        <div class="mr-3 text-sm">Balance:</div>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5">
                        <button
                            class="btn btn-primary w-full ping-connect-confirm capitalize text-base"
                            :class="sending ? 'loading' : ''"
                            :disabled="disableDeposit"
                            @click="doDeposit"
                        >
                            Deposit
                        </button>
                    </div>
                </div>

                <!-- withdraw -->
                <div :class="view !== 'withdraw'?'hidden':''">
                    <h3 class="text-xl font-semibold flex"><Icon class="mt-1" icon="mdi:chevron-left" @click="switchView('swap')"></Icon> Withdraw</h3>
                    <div class="form-control">
                        <label class="label">
                            <span class="label-text">Recipient</span>
                        </label>
                        <input :value="sender.cosmosAddress" readonly type="text" class="input input-bordered" />
                    </div>
                    <div
                        class="flex items-center relative h-14 bg-gray-100 dark:bg-[#232333] rounded-tl-lg rounded-tr-lg mt-4"
                    >
                        <label
                            tabindex="0"
                            class="flex items-center h-12 px-4 cursor-pointer"
                        >
                            <img
                                :src="swapOut?.coinImageUrl"
                                class="w-8 h-8 mr-3 rounded-full"
                            />
                            <div class="text-lg font-semibold mr-2">
                                {{ swapOut?.symbol }}
                            </div>
                        </label>
                        <input
                            v-model="withdrawAmount"
                            type="number"
                            placeholder="1"
                            class="input bg-transparent flex-1 h-14 text-right text-lg font-bold"
                        />
                    </div>

                    <div
                        class="flex flex-row-reverse items-center py-2 px-4 bg-gray-200 dark:bg-[#171721] rounded-bl-lg rounded-br-lg"
                    >
                        <div class="text-base font-semibold">
                            {{ showBalance(swapOut?.ibcDenom, swapOut?.decimals) }}
                        </div>
                        <div class="mr-3 text-sm">Balance:</div>
                    </div>

                    <div v-if="error" class="text-error mt-3">
                        <span>{{ error }}.</span>
                    </div>

                    <div class="mt-5">
                        <button
                            class="btn btn-primary w-full ping-connect-confirm capitalize text-base"
                            :class="sending ? 'loading' : ''"
                            :disabled="disableWithdraw"
                            @click="doWithdraw()"
                        >
                            Withdraw
                        </button>
                    </div>
                </div>
            </label>
        </label>
    </div>
</template>
<script lang="ts">
export default {
    name: 'TokenConvert',
};
</script>

<style scoped></style>
