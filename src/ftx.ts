import Decimal from "decimal.js"
import fetch from "node-fetch"
import { NewOrderReq, RestClient, WebsocketClient } from "ftx-api"

export class FtxArbClient {
	private client: RestClient
	private wsClient: WebsocketClient
	private market: FtxMarket
	private account: FtxAccountInfo
	private orderbook: FtxOrderbook

	constructor() {
		this.client = new RestClient(
			process.env.FTX_KEY,
			process.env.FTX_SECRET,
			{ subAccountName: process.env.FTX_SUBACCOUNT },
		)
		this.wsClient = new WebsocketClient({
			key: process.env.FTX_KEY,
			secret: process.env.FTX_SECRET,
			subAccountName: process.env.FTX_SUBACCOUNT,
		})
	}

	async init() {
		this.market = await this.getMarket("SOL-PERP")
	}

	orderbookSubscribe(marketName: string, fn) {
		this.wsClient.subscribe({ channel: "orderbook", market: marketName })
		this.wsClient.addListener("update", (up) => {
			fn()
			this.orderbookUpdate.bind(this)(up)
		})
	}

	orderbookUpdate(update: any): void {
		if (update.type === "subscribed") {
			return
		}
		if (update.data.action === "partial") {
			this.orderbook = {
				asks: update.data.asks,
				bids: update.data.bids,
			}
		} else if (update.data.action === "update") {
			this.updateAsks.bind(this)(update.data.asks)
			this.updateBids.bind(this)(update.data.bids)
		}
	}

	updateAsks(update: Decimal[][]): void {
		let ob = this.orderbook.asks

		let obIdx = 0
		let updateIdx = 0
		let newBook: Decimal[][] = new Array()

		while (obIdx < ob.length && updateIdx < update.length) {
			if (ob[obIdx]! < update[updateIdx]!) {
				newBook.push(ob[obIdx]!)
				obIdx += 1
			} else if (ob[obIdx]! > update[updateIdx]!) {
				newBook.push(update[updateIdx]!)
				updateIdx += 1
			} else {
				if (update[updateIdx]![1] !== new Decimal(0)) {
					newBook.push(update[updateIdx]!)
					obIdx += 1
					updateIdx += 1
				}
			}
		}

		if (obIdx < ob.length) {
			newBook.concat(ob.slice(obIdx))
		}
		if (updateIdx < update.length) {
			newBook.concat(update.slice(updateIdx))
		}

		this.orderbook.asks = newBook
	}

	updateBids(update: Decimal[][]): void {
		let ob = this.orderbook.bids

		let obIdx = 0
		let updateIdx = 0
		let newBook: Decimal[][] = new Array()

		while (obIdx < ob.length && updateIdx < update.length) {
			if (ob[obIdx]! > update[updateIdx]!) {
				newBook.push(ob[obIdx]!)
				obIdx += 1
			} else if (ob[obIdx]! < update[updateIdx]!) {
				newBook.push(update[updateIdx]!)
				updateIdx += 1
			} else {
				if (update[updateIdx]![1] !== new Decimal(0)) {
					newBook.push(update[updateIdx]!)
					obIdx += 1
					updateIdx += 1
				}
			}
		}

		if (obIdx < ob.length) {
			newBook.concat(ob.slice(obIdx))
		}
		if (updateIdx < update.length) {
			newBook.concat(update.slice(updateIdx))
		}

		this.orderbook.bids = newBook
	}

	getOrderbook(): FtxOrderbook {
		return this.orderbook
	}

	async getMarket(marketName: string): Promise<FtxMarket> {
		const response = await fetch(
			`https://ftx.com/api/markets/${marketName}`,
		)
		const result: any[] = (await response.json()).result
		return this.toFtxMarket(result)
	}

	async refresh(): Promise<void> {
		this.market = await this.getMarket("SOL-PERP")
		return
	}

	getAsk(): Decimal {
		if (this.orderbook !== undefined) return this.orderbook.asks[0]![0]!
		else return this.market.ask
	}

	getBid(): Decimal {
		if (this.orderbook !== undefined) return this.orderbook.bids[0]![0]!
		else return this.market.bid
	}

	async getFtxAccountInfo(): Promise<FtxAccountInfo> {
		const data = await this.client.getAccount()
		const positionsMap: Record<string, FtxPosition> = {}
		for (let i = 0; i < data.result.positions.length; i++) {
			const positionEntity = data.result.positions[i]
			const position = this.toFtxPosition(positionEntity)
			positionsMap[position.future] = position
		}

		return {
			freeCollateral: new Decimal(data.result.freeCollateral),
			totalAccountValue: new Decimal(data.result.totalAccountValue),
			// marginFraction is null if the account has no open positions
			marginFraction: new Decimal(
				data.result.marginFraction ? data.result.marginFraction : 0,
			),
			maintenanceMarginRequirement: new Decimal(
				data.result.maintenanceMarginRequirement,
			),
			positionsMap: positionsMap,
		}
	}
	async getPosition(ftxClient: any, marketId: string): Promise<FtxPosition> {
		const data = await ftxClient.request({
			method: "GET",
			path: "/positions",
		})
		const positions: Record<string, FtxPosition> = {}
		for (let i = 0; i < data.result.length; i++) {
			const positionEntity = data.result[i]
			if (positionEntity.future === marketId) {
				const position = this.toFtxPosition(positionEntity)
				positions[position.future] = position
			}
		}
		return positions[marketId]
	}

	async getTotalPnLs(ftxClient: any): Promise<Record<string, number>> {
		const data = await ftxClient.request({
			method: "GET",
			path: "/pnl/historical_changes",
		})
		return data.result.totalPnl
	}

	async placeOrder(payload: NewOrderReq): Promise<void> {
		const data = await this.client.placeOrder(payload)
	}

	// noinspection JSMethodCanBeStatic
	private toFtxMarket(market: any): FtxMarket {
		return {
			name: market.name,
			bid: market.bid ? new Decimal(market.bid) : undefined,
			ask: market.ask ? new Decimal(market.ask) : undefined,
			last: market.last ? new Decimal(market.last) : undefined,
		}
	}

	// noinspection JSMethodCanBeStatic
	private toFtxPosition(positionEntity: any): FtxPosition {
		return {
			future: positionEntity.future,
			netSize: new Decimal(positionEntity.netSize),
			entryPrice: new Decimal(
				positionEntity.entryPrice ? positionEntity.entryPrice : 0,
			),
			realizedPnl: new Decimal(
				positionEntity.realizedPnl ? positionEntity.realizedPnl : 0,
			),
			cost: new Decimal(positionEntity.cost ? positionEntity.cost : 0),
		}
	}
}

export interface FtxAccountInfo {
	freeCollateral: Decimal
	totalAccountValue: Decimal
	marginFraction: Decimal
	maintenanceMarginRequirement: Decimal
	positionsMap: Record<string, FtxPosition>
}

export interface PlaceOrderPayload {
	market: string
	side: string
	price: null
	size: number
	type: string
}

export interface FtxPosition {
	future: string
	netSize: Decimal // + is long and - is short
	entryPrice: Decimal
	realizedPnl: Decimal
	cost: Decimal
}

export interface FtxMarket {
	name: string
	bid: Decimal
	ask: Decimal
	last?: Decimal
}

export interface FtxOrderbook {
	asks: Decimal[][]
	bids: Decimal[][]
}

export interface FtxOrderbookUpdate {
	channel: string
	market: string
	type: string
	data: {
		time: Decimal
		checksum: number
		bids: Decimal[][]
		asks: Decimal[][]
		action: string
	}
}
