import {Commitment} from '@solana/web3.js'
import {
    Cluster,
    getKeypairFromSecretKey,
    // sleep,
    Wallet,
    walletFromKeyPair,
    Zamm,
    ZAMM_SOL_KEY,
    ZoUser
} from '@zero_one/client'
import {config} from 'dotenv'
import Decimal from 'decimal.js'
import {UpdateEvents} from './types'

/**
 * This loads the config data from .env.development.local or from .env.production.local
 *
 * Config examples are available in configExamples folder
 */

config({path: `.env.${process.env.NODE_ENV || 'development'}.local`})
const SECRET_KEY = process.env.SECRET_KEY
const COMMITMENT: Commitment = process.env.COMMITMENT! as Commitment
const SKIP_PREFLIGHT: boolean = process.env.SKIP_PREFLIGHT == 'true'
const RPC_URL: string = process.env.RPC_URL!
const CLUSTER: Cluster = process.env.CLUSTER! as Cluster

async function run() {
    // this is a simple way to load anchor wallet from Keypair
    const keypair = getKeypairFromSecretKey(SECRET_KEY)
    const wallet: Wallet = walletFromKeyPair(keypair)

    const arbUser = await ZoUser.load(wallet, CLUSTER, {
        withRealm: false,
        commitment: COMMITMENT,
        skipPreflight: SKIP_PREFLIGHT,
        rpcUrl: RPC_URL
    })
    const zamm = await Zamm.load(arbUser.program, ZAMM_SOL_KEY, arbUser.state, COMMITMENT)

    /**
     * Here arbUser and zamm subscribe to changes and monitor them across Zero One exchange including arber margin, oracle prices, zamm
     * xSensitivity=10 means that event will be only fired if X changes by at least 1/10=0.1 SOL-PERP in balance
     * ySensitivity=100 means that event will be only fired if Y changes by at least 1/100=0.01 USD in balance
     */
    await arbUser.subscribe(false)
    const xSensitivity = 1, ySensitivity = 1
    await zamm.subscribe(xSensitivity, ySensitivity)

    async function arb({
                           X,
                           Y,
                           price
                       }: { X: Decimal, Y: Decimal, price: Decimal }) {
        console.log(X.toNumber(), Y.toNumber(), price.toNumber())
        /*
        X - corresponds to the amount of SOL/SOL-PERP in the ZAMM (Decimal)
        Y - corresponds to the amount of USD in the ZAMM (Decimal)
        price - corresponds to the price of SOL-PERP according to ZAMM
        Here is the code where one can put the logic behind arbing ZAMM:

        // here's how one can get pyth oracle price
        const indexPrice = zamm.ZammMargin.state.markets[zamm.marketSymbol].indexPrice.decimal


        //this is the call to make a ZAMM order with a price limit
        await zamm.limitArb(arbUser.margin)
        const myLimitX =  1.0 //buying one SOL-PERP
        const myLimitPrice = 50 // my limit price for this arb is 50$
        await zamm.limitArb(arbUser.margin, myLimitX, myLimitPrice)  // buying myLimitX SOL-PERP from ZAMM at no higher than myLimitPrice


        //this is the call to make a ZAMM market arb order [get filled at any price]
        await zamm.limitArb(arbUser.margin, x, limitPrice)
        const myX =  1.0 //buying one SOL-PERP
        await zamm.marketArb(arbUser.margin, myLimitX) // buying myLimitX SOL-PERP from ZAMM at any price

         //at the same time one can add below the code to call other DEX/CEX to hedge the exposure from 01.
         */
    }

    // Here is a simple event listener which responds to any changes affecting X or Y in ZAMM
    zamm.eventEmitter!.addListener(UpdateEvents.zammModified, arb)

    /**
     * this is an alternative to arb function which allows locked access to the arb function, so one cannot avoid worrying about arbing twice at the same time before finishing the first arb
     * WARNING: this is not the safest implementation. Recommend implementing a separate solution depending on one's needs.
     */
    const arbUpdatesQueue: Array<{ X: Decimal, Y: Decimal, price: Decimal }> = []
    let locked = false

    function lockedArb({
                           X,
                           Y,
                           price
                       }: { X: Decimal, Y: Decimal, price: Decimal }) {
        if (locked) {
            arbUpdatesQueue.push({
                X,
                Y,
                price
            })
            return
        }

        locked = true

        arb({X, Y, price})

        if (arbUpdatesQueue.length > 0) {
            locked = false
            const update = arbUpdatesQueue.shift()!
            lockedArb(update)
        }
    }

    // Here is a simple event listener which responds to any changes affecting X or Y in ZAMM
    // zamm.eventEmitter!.addListener(UpdateEvents.zammModified, lockedArb)
}

run().then()
