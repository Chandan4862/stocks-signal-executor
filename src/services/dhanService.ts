/*
 DhanService: Interacts with Dhan API for orders and related actions.
 Access tokens typically have ~30 days lifespan; sourced via TokenService.
*/

import axios, { AxiosInstance } from "axios";
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

  constructor(
    private cfg: AppConfig,
    private tokens: TokenService,
  ) {}

  private async ensureHttp(): Promise<AxiosInstance> {
    if (this.http) return this.http;
    const token = await this.tokens.getToken();
    if (!token) throw new Error("Missing Dhan access token");
    this.http = axios.create({
      baseURL: "https://api.dhan.co/v2",
      headers: {
        "Content-Type": "application/json",
        "access-token": token,
      },
      timeout: 10000,
    });
    return this.http;
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    // const http = await this.ensureHttp();
    // const { data } = await http.post<PlaceOrderResponse>("/orders", req);
    // return data;
    console.log("DhanService.placeOrder called with:", req);
    return {
      orderStatus: "success",
      orderId: "DhanOrder12345",
    };
  }

  async placeSuperOrder(
    req: PlaceSuperOrderRequest,
  ): Promise<PlaceOrderResponse> {
    // const http = await this.ensureHttp();
    // const { data } = await http.post<PlaceOrderResponse>("/super/orders", req);
    // return data;
    return {
      orderId: String(req.correlationId || "superOrder"),
      orderStatus: "success",
    };
  }

  async modifyOrder(
    orderId: string,
    req: Partial<PlaceOrderRequest> & {
      orderType: OrderType;
      validity: Validity;
    },
  ): Promise<PlaceOrderResponse> {
    const http = await this.ensureHttp();
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
  }

  async cancelOrder(
    orderId: string,
  ): Promise<{ orderId: string; orderStatus: string }> {
    const http = await this.ensureHttp();
    const { data } = await http.delete<{
      orderId: string;
      orderStatus: string;
    }>(`/orders/${orderId}`);
    return data;
  }
}
