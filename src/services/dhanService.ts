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

import { AuditLogService } from "./auditLogService";
import { LifecycleEvents } from "../enums/trade";

/* ------------------------------------------------------------------ */
/*  Dhan API Error Handling                                            */
/* ------------------------------------------------------------------ */

/**
 * Dhan Trading API error codes (DH-9xx series).
 * See: https://dhanhq.co/docs/v2/annexure/
 */
const DHAN_ERROR_DESCRIPTIONS: Record<string, string> = {
  "DH-901": "Client ID or user generated access token is invalid or expired.",
  "DH-902":
    "User has not subscribed to Data APIs or does not have access to Trading APIs. Kindly subscribe to Data APIs to be able to fetch Data.",
  "DH-903":
    "Errors related to User's Account. Check if the required segments are activated or other requirements are met.",
  "DH-904":
    "Too many requests on server from single user breaching rate limits. Try throttling API calls.",
  "DH-905": "Missing required fields, bad values for parameters etc.",
  "DH-906": "Incorrect request for order and cannot be processed.",
  "DH-907":
    "System is unable to fetch data due to incorrect parameters or no data present.",
  "DH-908":
    "Server was not able to process API request. This will only occur rarely.",
  "DH-909":
    "Network error where the API was unable to communicate with the backend system.",
  "DH-910": "Error originating from other reasons.",
};

/**
 * Structured error for Dhan API failures.
 * Extracts Dhan-specific error details from Axios errors and order responses.
 */
export class DhanApiError extends Error {
  public readonly httpStatus: number | undefined;
  public readonly dhanErrorCode: string | undefined;
  public readonly dhanMessage: string | undefined;
  public readonly requestBody: any;
  public readonly responseBody: any;

  constructor(opts: {
    message: string;
    httpStatus?: number;
    dhanErrorCode?: string;
    dhanMessage?: string;
    requestBody?: any;
    responseBody?: any;
    cause?: Error;
  }) {
    super(opts.message);
    this.name = "DhanApiError";
    this.httpStatus = opts.httpStatus;
    this.dhanErrorCode = opts.dhanErrorCode;
    this.dhanMessage = opts.dhanMessage;
    this.requestBody = opts.requestBody;
    this.responseBody = opts.responseBody;
  }

  /** Flatten to a JSON-safe object for audit logging. */
  toAuditPayload(): Record<string, any> {
    return {
      error: this.message,
      httpStatus: this.httpStatus,
      dhanErrorCode: this.dhanErrorCode,
      dhanMessage: this.dhanMessage,
      dhanErrorDescription: this.dhanErrorCode
        ? DHAN_ERROR_DESCRIPTIONS[this.dhanErrorCode]
        : undefined,
      requestBody: this.requestBody,
      responseBody: this.responseBody,
    };
  }

  /**
   * Create a DhanApiError from an AxiosError.
   * Extracts Dhan's `errorCode`, `errorMessage`, `internalErrorCode`, `internalErrorMessage`
   * from the response body.
   */
  static fromAxiosError(err: AxiosError, requestBody?: any): DhanApiError {
    const status = err.response?.status;
    const body = err.response?.data as any;

    const dhanErrorCode =
      body?.errorCode ?? body?.internalErrorCode ?? undefined;
    const dhanMessage =
      body?.errorMessage ??
      body?.internalErrorMessage ??
      body?.message ??
      undefined;

    const description = dhanErrorCode
      ? (DHAN_ERROR_DESCRIPTIONS[dhanErrorCode] ?? "")
      : "";

    const message = [
      `Dhan API ${status ?? "?"}: ${err.message}`,
      dhanErrorCode ? `[${dhanErrorCode}]` : "",
      dhanMessage || description,
    ]
      .filter(Boolean)
      .join(" — ");

    return new DhanApiError({
      message,
      httpStatus: status,
      dhanErrorCode,
      dhanMessage: dhanMessage ?? description,
      requestBody,
      responseBody: body,
      cause: err,
    });
  }

  /**
   * Create a DhanApiError from a successful HTTP response where orderStatus
   * indicates rejection.
   */
  static fromRejectedOrder(
    response: PlaceOrderResponse,
    requestBody?: any,
  ): DhanApiError {
    return new DhanApiError({
      message: `Dhan order ${response.orderStatus}: orderId=${response.orderId}`,
      httpStatus: 200,
      dhanMessage: `Order returned ${response.orderStatus}`,
      requestBody,
      responseBody: response,
    });
  }
}

const RATE_LIMIT_RETRY_DELAY_MS = 1000;
const MAX_RATE_LIMIT_RETRIES = 2;

export class DhanService {
  private http?: AxiosInstance;
  private currentToken?: string;

  constructor(
    private cfg: AppConfig,
    private tokens: TokenService,
    private audit: AuditLogService,
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

      this.http.interceptors.request.use((config) => {
        const method = config.method?.toUpperCase() || "GET";
        const url = `${config.baseURL || ""}${config.url || ""}`;

        // Build Headers safely. We omit `common`, `delete`, `get`, `head`, `post`, `put`, `patch` which Axios includes sometimes.
        const headerPairs: string[] = [];
        for (const [key, value] of Object.entries(config.headers || {})) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            headerPairs.push(`-H '${key}: ${value}'`);
          }
        }

        const headers = headerPairs.join(" ");
        const data = config.data ? `-d '${JSON.stringify(config.data)}'` : "";

        const curlCommand =
          `> [Dhan API] cURL:\ncurl -X ${method} '${url}' \\\n  ${headers} \\\n  ${data}`.trim();

        // Log to audit_logs table
        this.audit
          .debug(LifecycleEvents.DHAN_API_CALL, { curl: curlCommand })
          .catch(() => {});

        return config;
      });
    }

    return this.http;
  }

  /**
   * Execute an HTTP call with automatic retry on:
   *   - 401/403: invalidate token → get fresh token → retry once
   *   - 429: wait 1s → retry up to 2 times
   *
   * All other Axios errors are mapped to DhanApiError with full context.
   */
  private async withAuthRetry<T>(
    fn: (http: AxiosInstance) => Promise<T>,
    requestBody?: any,
  ): Promise<T> {
    let rateLimitRetries = 0;

    const attempt = async (): Promise<T> => {
      try {
        const http = await this.ensureHttp();
        return await fn(http);
      } catch (err) {
        // 1. Auth error → invalidate + retry once
        if (this.isAuthError(err)) {
          this.audit
            .warn(LifecycleEvents.ERROR_OCCURRED, {
              action: "DhanService.withAuthRetry",
              error: "401/403 received — refreshing token and retrying",
            })
            .catch(() => {});
          await this.tokens.invalidateToken();
          this.http = undefined;
          const http = await this.ensureHttp();
          return await fn(http); // retry once; let it throw if still fails
        }

        // 2. Rate limit → backoff and retry
        if (
          err instanceof AxiosError &&
          err.response?.status === 429 &&
          rateLimitRetries < MAX_RATE_LIMIT_RETRIES
        ) {
          rateLimitRetries++;
          this.audit
            .warn(LifecycleEvents.ERROR_OCCURRED, {
              action: "DhanService.withAuthRetry",
              error: `429 Rate Limited — retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} after ${RATE_LIMIT_RETRY_DELAY_MS}ms`,
            })
            .catch(() => {});
          await this.sleep(RATE_LIMIT_RETRY_DELAY_MS);
          return attempt(); // recursive retry
        }

        // 3. All other Axios errors → wrap as DhanApiError
        if (err instanceof AxiosError) {
          throw DhanApiError.fromAxiosError(err, requestBody);
        }

        throw err;
      }
    };

    return attempt();
  }

  private isAuthError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      return err.response?.status === 401 || err.response?.status === 403;
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Assert that the order response indicates acceptance.
   * Dhan can return HTTP 200 with orderStatus = REJECTED/CANCELLED/EXPIRED.
   * In those cases, the order was NOT placed — we must throw.
   */
  private assertOrderAccepted(
    res: PlaceOrderResponse,
    requestBody?: any,
  ): void {
    const rejected = ["REJECTED", "CANCELLED", "EXPIRED"];
    if (rejected.includes(res.orderStatus)) {
      throw DhanApiError.fromRejectedOrder(res, requestBody);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Order operations                                                   */
  /* ------------------------------------------------------------------ */

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.post<PlaceOrderResponse>("/orders", req);
      this.assertOrderAccepted(data, req);
      return data;
    }, req);
  }

  async placeSuperOrder(
    req: PlaceSuperOrderRequest,
  ): Promise<PlaceOrderResponse> {
    return this.withAuthRetry(async (http) => {
      const { data } = await http.post<PlaceOrderResponse>(
        "/super/orders",
        req,
      );
      this.assertOrderAccepted(data, req);
      return data;
    }, req);
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
    }, req);
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
      this.assertOrderAccepted(data, req);
      return data;
    }, req);
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
    }, req);
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
      const { data } = await http.get("/forever/orders");
      if (!Array.isArray(data)) {
        this.audit
          .warn(LifecycleEvents.ERROR_OCCURRED, {
            action: "getForeverOrders",
            error: "Non-array response from Dhan forever/orders",
            responseBody: data,
          })
          .catch(() => {});
        return [];
      }
      return data;
    });
  }
}
