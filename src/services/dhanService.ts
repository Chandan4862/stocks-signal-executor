/*
  DhanService: Interacts with Dhan API v2 for orders and related actions.

  Auth: Every request includes header `access-token: <JWT>`.
  Tokens are managed by TokenService (24h validity, auto-renewable).
  On 401/403, the cached token is invalidated and a fresh one is obtained.
*/

import axios, { AxiosInstance, AxiosError } from "axios";
import type { AppConfig } from "../config/schema";
import { OrderState } from "../enums/trade";
import { TokenService } from "./tokenService";

export type TransactionType = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET" | "STOP_LOSS" | "STOP_LOSS_MARKET";
export type Validity = "DAY" | "IOC";

export interface PlaceOrderRequest {
  dhanClientId: string;
  correlationId?: string;
  transactionType: TransactionType;
  exchangeSegment: string; // e.g., NSE_EQ
  productType: string; // CNC, INTRADAY, etc.
  orderType: OrderType;
  validity: Validity;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price?: number;
  triggerPrice?: number;
  afterMarketOrder?: boolean;
  amoTime?: string;
  boProfitValue?: number;
  boStopLossValue?: number;
}

export interface PlaceOrderResponse {
  orderId: string;
  orderStatus: string;
}

export type OrderFlag = "SINGLE" | "OCO";
export type LegName = "ENTRY_LEG" | "TARGET_LEG" | "STOP_LOSS_LEG";

export interface PlaceForeverOrderRequest {
  dhanClientId: string;
  correlationId?: string;
  orderFlag: OrderFlag;
  transactionType: TransactionType;
  exchangeSegment: string;
  productType: string;
  orderType: OrderType;
  validity: Validity;
  securityId: string;
  quantity: number;
  disclosedQuantity?: number;
  price: number;
  triggerPrice: number;

  // Required only for OCO (Stop Loss Leg)
  price1?: number;
  triggerPrice1?: number;
  quantity1?: number;
}

export interface ModifyForeverOrderRequest {
  dhanClientId: string;
  orderId: string;
  orderFlag: OrderFlag;
  orderType: OrderType;
  legName: LegName;
  quantity: number;
  price: number;
  disclosedQuantity?: number;
  triggerPrice: number;
  validity: Validity;
}

export interface PlaceSuperOrderRequest {
  dhanClientId: string;
  correlationId?: string;
  transactionType: TransactionType; // BUY/SELL
  exchangeSegment: string; // e.g., NSE_EQ
  productType: string; // CNC
  orderType: OrderType; // LIMIT or MARKET
  securityId: string;
  quantity: number;
  price?: number;
  targetPrice?: number;
  stopLossPrice: number;
  trailingJump?: number; // absolute Rs jump for trailing
}

export class DhanService {
  private http?: AxiosInstance;
  private currentToken?: string;

  constructor(
    private cfg: AppConfig,
    private tokens: TokenService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  HTTP client with auto-refresh on 401                               */
  /* ------------------------------------------------------------------ */

  /**
   * Get or create an Axios instance authenticated with the current token.
   * If the token has changed (e.g. after invalidation + refresh), the
   * client is re-created with the new token.
   */
  private async ensureHttp(forceRefresh = false): Promise<AxiosInstance> {
    const token = await this.tokens.getToken();
    if (!token) throw new Error("Missing Dhan access token — trading paused");

    // Re-create client if token changed or forced
    if (!this.http || this.currentToken !== token || forceRefresh) {
      this.currentToken = token;
      const baseURL =
        this.cfg.env === "development"
          ? "https://sandbox.dhan.co/v2"
          : "https://api.dhan.co/v2";

      this.http = axios.create({
        baseURL,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "access-token": token,
        },
        timeout: 10_000,
      });
    }

    return this.http;
  }

  /**
   * Execute an HTTP call with automatic retry on 401/403.
   * On auth failure: invalidate cached token → get fresh token → retry once.
   */
  private async withAuthRetry<T>(
    fn: (http: AxiosInstance) => Promise<T>,
  ): Promise<T> {
    try {
      const http = await this.ensureHttp();
      return await fn(http);
    } catch (err) {
      if (this.isAuthError(err)) {
        console.warn(
          "DhanService: 401/403 received — refreshing token and retrying…",
        );
        await this.tokens.invalidateToken();
        this.http = undefined; // force re-creation
        const http = await this.ensureHttp();
        return await fn(http); // retry once; let it throw if still fails
      }
      throw err;
    }
  }

  private isAuthError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      return err.response?.status === 401 || err.response?.status === 403;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Order operations                                                   */
  /* ------------------------------------------------------------------ */

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.post<PlaceOrderResponse>("/orders", req);
      return data;
    });
  }

  async placeSuperOrder(
    req: PlaceSuperOrderRequest,
  ): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.post<PlaceOrderResponse>(
        "/super/orders",
        req,
      );
      return data;
    });
  }

  async modifyOrder(
    orderId: string,
    req: Partial<PlaceOrderRequest> & {
      orderType: OrderType;
      validity: Validity;
    },
  ): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const body: any = {
        dhanClientId: this.cfg.dhan.clientId,
        orderId,
        ...req,
      };
      const { data } = await http.put<PlaceOrderResponse>(
        `/orders/${orderId}`,
        body,
      );
      return data;
    });
  }

  async cancelOrder(
    orderId: string,
  ): Promise<{ orderId: string; orderStatus: string }> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.delete<{
        orderId: string;
        orderStatus: string;
      }>(`/orders/${orderId}`);
      return data;
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Forever Order (GTT) operations                                    */
  /* ------------------------------------------------------------------ */

  async placeForeverOrder(
    req: PlaceForeverOrderRequest,
  ): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.post<PlaceOrderResponse>(
        "/forever/orders",
        req,
      );
      return data;
    });
  }

  async modifyForeverOrder(
    orderId: string,
    req: ModifyForeverOrderRequest,
  ): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.put<PlaceOrderResponse>(
        `/forever/orders/${orderId}`,
        req,
      );
      return data;
    });
  }

  async cancelForeverOrder(
    orderId: string,
  ): Promise<{ orderId: string; orderStatus: string }> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.delete<{
        orderId: string;
        orderStatus: string;
      }>(`/forever/orders/${orderId}`);
      return data;
    });
  }

  async getForeverOrders(): Promise<any[]> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.get<any[]>("/forever/all");
      return data;
    });
  }
}
