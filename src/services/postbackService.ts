/**
 * PostbackService: Lightweight HTTP server for Dhan Postback (Webhook) callbacks.
 *
 * Dhan sends a POST request with JSON payload whenever an order status changes:
 *   TRANSIT → PENDING → TRADED / CANCELLED / REJECTED / EXPIRED
 *
 * This service:
 *   1. Receives and stores raw postback in `postback_log` table
 *   2. Matches orderId to trades table (buy_order_id or exit_order_id)
 *   3. Processes state transitions (same logic as monitorPendingEntries + monitorEnteredTrades)
 *   4. Sends Telegram notifications for trade events
 *
 * Setup: Set POSTBACK_PORT in .env and provide the public URL to Dhan when generating access token.
 */

import http from "http";
import type { Client } from "pg";
import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

export interface PostbackPayload {
  dhanClientId: string;
  orderId: string;
  correlationId: string;
  orderStatus:
    | "TRANSIT"
    | "PENDING"
    | "REJECTED"
    | "CANCELLED"
    | "TRADED"
    | "EXPIRED";
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  validity: string;
  tradingSymbol: string;
  securityId: string;
  quantity: number;
  disclosedQuantity: number;
  price: number;
  triggerPrice: number;
  afterMarketOrder: boolean;
  createTime: string;
  updateTime: string;
  exchangeTime: string;
  drvExpiryDate: string | null;
  drvOptionType: string | null;
  drvStrikePrice: number;
  omsErrorCode: string | null;
  omsErrorDescription: string | null;
  filled_qty: number;
  algoId: string | null;
}

export class PostbackService {
  private server?: http.Server;

  constructor(
    private pg: Client,
    private audit: AuditLogService,
  ) {}

  /**
   * Start the HTTP server on the given port.
   */
  start(port: number): void {
    this.server = http.createServer(async (req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Only accept POST /webhook/dhan
      if (req.method !== "POST" || req.url !== "/webhook/dhan") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      try {
        const body = await this.readBody(req);
        const payload: PostbackPayload = JSON.parse(body);

        // Respond immediately (Dhan expects fast response)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));

        // Process asynchronously
        await this.handlePostback(payload);
      } catch (err: any) {
        res.writeHead(400);
        res.end("Bad request");
        this.audit
          .warn(LifecycleEvents.ERROR_OCCURRED, {
            action: "PostbackService.request",
            error: err?.message ?? "Invalid postback payload",
          })
          .catch(() => {});
      }
    });

    this.server.listen(port, () => {
      this.audit
        .info(LifecycleEvents.DHAN_API_CALL, {
          service: "PostbackService",
          action: "start",
          message: `Postback webhook server listening on port ${port}`,
        })
        .catch(() => {});
    });
  }

  /**
   * Graceful shutdown.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Core postback handler                                              */
  /* ------------------------------------------------------------------ */

  private async handlePostback(payload: PostbackPayload): Promise<void> {
    const {
      orderId,
      correlationId,
      orderStatus,
      transactionType,
      securityId,
      tradingSymbol,
      quantity,
      price,
      filled_qty,
      omsErrorCode,
      omsErrorDescription,
    } = payload;

    // 1. Store raw postback
    await this.storePostback(payload);

    // 2. Only process terminal states
    if (!["TRADED", "CANCELLED", "REJECTED", "EXPIRED"].includes(orderStatus)) {
      return;
    }

    // 3. Match to trades table — check both buy_order_id and exit_order_id
    const tradeRes = await this.pg.query(
      `SELECT * FROM trades
       WHERE buy_order_id = $1 OR exit_order_id = $1
       LIMIT 1`,
      [String(orderId)],
    );

    if (tradeRes.rows.length === 0) {
      // Order not managed by us — skip
      await this.audit.info(LifecycleEvents.DHAN_API_CALL, {
        action: "PostbackService.unmatched",
        orderId,
        orderStatus,
        tradingSymbol,
      });
      return;
    }

    const trade = tradeRes.rows[0];
    const isBuyOrder = String(trade.buy_order_id) === String(orderId);
    const isExitOrder = String(trade.exit_order_id) === String(orderId);

    // 4. Process based on which order matched
    if (isBuyOrder) {
      await this.handleBuyOrderUpdate(trade, payload);
    } else if (isExitOrder) {
      await this.handleExitOrderUpdate(trade, payload);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Buy order updates (AWAITING_ENTRY state)                           */
  /* ------------------------------------------------------------------ */

  private async handleBuyOrderUpdate(
    trade: any,
    payload: PostbackPayload,
  ): Promise<void> {
    const { orderId, orderStatus, price } = payload;

    if (trade.state !== "AWAITING_ENTRY") return;

    if (orderStatus === "TRADED") {
      // Entry triggered! Update to ENTERED.
      // Note: OCO exit is placed by the polling loop (monitorPendingEntries).
      // The postback gives us real-time awareness, but the OCO placement
      // still happens in the scheduler tick to avoid race conditions.
      const tradedPrice = price > 0 ? price : Number(trade.entry_price);

      await this.pg.query(
        `UPDATE trades SET entry_price = $1 WHERE id = $2 AND state = 'AWAITING_ENTRY'`,
        [tradedPrice, trade.id],
      );

      await this.audit.info(LifecycleEvents.BUY_PLACED, {
        id: trade.id,
        source: "postback",
        message:
          "Entry order TRADED (via postback). Awaiting OCO placement by scheduler.",
        tradedPrice,
        orderId,
      });

      await this.audit.notify(
        `⚡ POSTBACK: Entry Triggered\n` +
          `Symbol: ${trade.symbol}\n` +
          `Traded @ ₹${tradedPrice} | Qty: ${trade.quantity}\n` +
          `OCO exit will be placed on next tick.`,
      );
    } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(orderStatus)) {
      await this.pg.query(
        `UPDATE trades SET state = 'CANCELLED' WHERE id = $1`,
        [trade.id],
      );

      await this.audit.warn(LifecycleEvents.ERROR_OCCURRED, {
        id: trade.id,
        source: "postback",
        action: `Entry order ${orderStatus}`,
        orderId,
        omsErrorCode: payload.omsErrorCode,
        omsErrorDescription: payload.omsErrorDescription,
      });

      await this.audit.notify(
        `⚡ POSTBACK: Entry ${orderStatus}\n` +
          `Symbol: ${trade.symbol}\n` +
          `Order: ${orderId}` +
          (payload.omsErrorDescription
            ? `\nReason: ${payload.omsErrorDescription}`
            : ""),
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Exit order updates (ENTERED state)                                 */
  /* ------------------------------------------------------------------ */

  private async handleExitOrderUpdate(
    trade: any,
    payload: PostbackPayload,
  ): Promise<void> {
    const { orderId, orderStatus, price } = payload;

    if (trade.state !== "ENTERED") return;

    if (orderStatus === "TRADED") {
      // Exit triggered — SL or Target hit
      const exitPrice = price > 0 ? price : Number(trade.entry_price);
      const entryPrice = Number(trade.entry_price);
      const qty = Number(trade.quantity);
      const pnl = (exitPrice - entryPrice) * qty;
      const pnlSign = pnl >= 0 ? "+" : "";
      const emoji = pnl >= 0 ? "🟢" : "🔴";

      await this.pg.query(
        `UPDATE trades SET state = 'CLOSED', exited_at = NOW(), exit_price = $1 WHERE id = $2`,
        [exitPrice, trade.id],
      );

      // Record PnL
      try {
        await this.pg.query(
          `INSERT INTO pnl_records (trade_id, tradingsymbol, quantity, entry_price, exit_price, realized_pnl, exited_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            trade.id,
            trade.tradingsymbol || trade.symbol,
            qty,
            entryPrice,
            exitPrice,
            pnl,
          ],
        );
      } catch {}

      await this.audit.info(LifecycleEvents.SELL_PLACED, {
        id: trade.id,
        source: "postback",
        message: "Exit order TRADED (via postback). Position closed.",
        exitPrice,
        pnl,
      });

      await this.audit.notify(
        `⚡ ${emoji} POSTBACK: Exit Triggered — Position Closed\n` +
          `Symbol: ${trade.symbol}\n` +
          `Entry: ₹${entryPrice} → Exit: ₹${exitPrice}\n` +
          `Qty: ${qty} | PnL: ${pnlSign}₹${pnl.toFixed(2)}`,
      );
    } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(orderStatus)) {
      // Exit order failed — position UNPROTECTED
      await this.audit.critical(LifecycleEvents.ERROR_OCCURRED, {
        id: trade.id,
        source: "postback",
        action: `Exit order ${orderStatus} — position UNPROTECTED!`,
        orderId,
        symbol: trade.symbol,
        omsErrorCode: payload.omsErrorCode,
        omsErrorDescription: payload.omsErrorDescription,
      });

      await this.audit.notify(
        `⚡ 🚨 POSTBACK: Exit Order ${orderStatus}\n` +
          `Symbol: ${trade.symbol}\n` +
          `Qty: ${trade.quantity} — Position UNPROTECTED!\n` +
          `Order: ${orderId}\n` +
          `Manual action required.`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  private async storePostback(payload: PostbackPayload): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO postback_log
           (order_id, correlation_id, order_status, transaction_type, security_id,
            trading_symbol, quantity, filled_qty, price, trigger_price, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          payload.orderId,
          payload.correlationId,
          payload.orderStatus,
          payload.transactionType,
          payload.securityId,
          payload.tradingSymbol,
          payload.quantity,
          payload.filled_qty,
          payload.price,
          payload.triggerPrice,
          JSON.stringify(payload),
        ],
      );
    } catch (err: any) {
      this.audit
        .warn(LifecycleEvents.ERROR_OCCURRED, {
          action: "PostbackService.storePostback",
          error: err?.message,
        })
        .catch(() => {});
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }
}
