import { Commitment } from "@solana/web3.js"
import {
	Cluster,
	getKeypairFromSecretKey,
	sleep,
	UpdateEvents,
	Wallet,
	walletFromKeyPair,
	Zamm,
	ZAMM_SOL_KEY,
	ZoUser,
} from "@zero_one/client"
import { FtxArbClient } from "./ftx"
import { config } from "dotenv"
import Decimal from "decimal.js"

/**
 * This loads the config data from .env.development.local or from .env.production.local
 *
 * Config examples are available in configExamples folder
 */

config({ path: `.env.${process.env.NODE_ENV || "development"}.local` })
const SECRET_KEY = process.env.SECRET_KEY
const COMMITMENT: Commitment = process.env.COMMITMENT! as Commitment
const SKIP_PREFLIGHT: boolean = process.env.SKIP_PREFLIGHT == "true"
const RPC_URL: string = process.env.RPC_URL!
const CLUSTER: Cluster = process.env.CLUSTER! as Cluster
const MIN_PROFIT_MARGIN: number = parseFloat(process.env.MIN_PROFIT_MARGIN!)
const MAX_NOTIONAL_SIZE: number = parseFloat(process.env.MAX_NOTIONAL_SIZE!)
const ORDER_SIZE: number = parseFloat(process.env.ORDER_SIZE!)

async function run() {
	// this is a simple way to load anchor wallet from Keypair
	const keypair = getKeypairFromSecretKey(SECRET_KEY)
	const wallet: Wallet = walletFromKeyPair(keypair)
	const ftxClient: FtxArbClient = new FtxArbClient()
	await ftxClient.init()

	const arbUser = await ZoUser.load(wallet, CLUSTER, {
		withRealm: false,
		commitment: COMMITMENT,
		skipPreflight: SKIP_PREFLIGHT,
		rpcUrl: RPC_URL,
	})
	const zamm = await Zamm.load(
		arbUser.program,
		ZAMM_SOL_KEY,
		arbUser.state,
		COMMITMENT,
	)

	/**
	 * Here arbUser and zamm subscribe to changes and monitor them across Zero One exchange including arber margin, oracle prices, zamm
	 * xSensitivity=10 means that event will be only fired if X changes by at least 1/10=0.1 SOL-PERP in balance
	 * ySensitivity=100 means that event will be only fired if Y changes by at least 1/100=0.01 USD in balance
	 */
	await arbUser.subscribe(false)
	const xSensitivity = 10,
		ySensitivity = 100
	await zamm.subscribe(xSensitivity, ySensitivity)

	ftxClient.orderbookSubscribe("SOL-PERP", arb)

	let x = new Decimal(0)
	let y = new Decimal(0)
	let zammPrice = new Decimal(0)

	async function updateZamm({
		X,
		Y,
		price,
	}: {
		X: Decimal
		Y: Decimal
		price: Decimal
	}) {
		x = X
		y = Y
		zammPrice = price
		arb()
	}

	async function arb() {
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
		const ftx_price = ftxClient.getAsk().add(ftxClient.getBid()).div(2)

		const diff = ftx_price
			.sub(zammPrice)
			.div(zammPrice.add(ftx_price).div(2))

		console.log(
			`Zamm price is $${zammPrice} and FTX price is $${ftx_price}: diff is ${diff.mul(
				100,
			)}%`,
		)

		const open_notional = arbUser.totalPositionNotional
		const isLong = arbUser.positions.find((pos) => {
			if (pos.marketKey === "SOL-PERP") {
				return pos.isLong
			}
		})

		const size =
			Math.min(ORDER_SIZE, MAX_NOTIONAL_SIZE - open_notional.toNumber()) /
			ftx_price.toNumber()

		const can_open_short = size > 0 || isLong
		const can_open_long = size > 0 || !isLong

		if (diff.lessThan(-MIN_PROFIT_MARGIN / 100) && can_open_short) {
			console.log(`Shorting Zamm for ${size} SOL-PERP at $${zammPrice}.`)
			console.log(`Longing FTX for ${size} SOL-PERP at $${ftx_price}.`)
			/*
			await zamm.limitArb(
				arbUser.margin,
				size,
				price.mul(0.999).toNumber(),
				false,
			)
			await ftxClient.placeOrder({
				market: "SOL-PERP",
				price: ftx_price.mul(1.001).toNumber(),
				side: "buy",
				type: "limit",
				size: size,
			})
			*/
		} else if (diff.greaterThan(MIN_PROFIT_MARGIN / 100) && can_open_long) {
			console.log(`Longing Zamm for ${size} SOL-PERP at $${zammPrice}.`)
			console.log(`Shorting FTX for ${size} SOL-PERP at $${ftx_price}.`)
			/*
			await zamm.limitArb(
				arbUser.margin,
				size,
				price.mul(1.00001).toNumber(),
				true,
			)
			await ftxClient.placeOrder({
				market: "SOL-PERP",
				price: ftx_price.mul(0.999).toNumber(),
				side: "sell",
				type: "limit",
				size: size,
			})
			*/
		} else {
			console.log(`No arb`)
		}
	}

	// Here is a simple event listener which responds to any changes affecting X or Y in ZAMM
	//zamm.eventEmitter!.addListener(UpdateEvents.zammModified, arb)

	/**
	 * this is an alternative to arb function which allows locked access to the arb function, so one cannot avoid worrying about arbing twice at the same time before finishing the first arb
	 * WARNING: this is not the safest implementation. Recommend implementing a separate solution depending on one's needs.
	 */
	const arbUpdatesQueue: Array<{ X: Decimal; Y: Decimal; price: Decimal }> =
		[]
	let locked = false

	function lockedArb({
		X,
		Y,
		price,
	}: {
		X: Decimal
		Y: Decimal
		price: Decimal
	}) {
		if (locked) {
			arbUpdatesQueue.push({
				X,
				Y,
				price,
			})
			return
		}

		locked = true

		arb()

		if (arbUpdatesQueue.length > 0) {
			locked = false
			const update = arbUpdatesQueue.shift()!
			lockedArb(update)
		}
	}

	// Here is a simple event listener which responds to any changes affecting X or Y in ZAMM
	zamm.eventEmitter!.addListener(UpdateEvents.zammModified, updateZamm)
}

run().then()
