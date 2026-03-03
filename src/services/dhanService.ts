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
      this.http = axios.create({
        baseURL: "https://api.dhan.co/v2",
        headers: {
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
}
