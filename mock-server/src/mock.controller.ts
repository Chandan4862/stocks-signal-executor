/*
  Mock Controller: Mode-aware middleware for allSuccess vs random behavior.
  In random mode, injects failures + latency based on configured rates.
*/

import type { Request, Response, NextFunction } from "express";
import type { MockConfig } from "./config";

/** Realistic Dhan API error payloads */
const DHAN_ERRORS = [
  {
    status: 400,
    body: {
      errorCode: "DH-901",
      httpStatus: "BAD_REQUEST",
      internalErrorCode: "DH-901",
      internalErrorMessage: "Invalid request parameters",
      message: "Order validation failed: Invalid security ID",
    },
  },
  {
    status: 401,
    body: {
      errorCode: "DH-902",
      httpStatus: "UNAUTHORIZED",
      internalErrorCode: "DH-902",
      internalErrorMessage: "Token expired or invalid",
      message: "Access token is invalid or expired. Please generate a new token.",
    },
  },
  {
    status: 429,
    body: {
      errorCode: "DH-903",
      httpStatus: "TOO_MANY_REQUESTS",
      internalErrorCode: "DH-903",
      internalErrorMessage: "Rate limit exceeded",
      message: "API rate limit exceeded. Please retry after some time.",
    },
  },
  {
    status: 500,
    body: {
      errorCode: "DH-999",
      httpStatus: "INTERNAL_SERVER_ERROR",
      internalErrorCode: "DH-999",
      internalErrorMessage: "Internal server error",
      message: "An unexpected error occurred. Please try again.",
    },
  },
  {
    status: 503,
    body: {
      errorCode: "DH-998",
      httpStatus: "SERVICE_UNAVAILABLE",
      internalErrorCode: "DH-998",
      internalErrorMessage: "Market hours ended",
      message: "Trading service is temporarily unavailable.",
    },
  },
];

/**
 * Creates middleware that randomly injects failures in "random" mode.
 * In "allSuccess" mode, this is a no-op pass-through.
 */
export function createMockMiddleware(config: MockConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // allSuccess mode — no interference
    if (config.mode === "allSuccess") {
      return next();
    }

    // random mode — add latency
    if (config.maxLatencyMs > 0) {
      const delay = Math.floor(Math.random() * config.maxLatencyMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // random mode — maybe fail
    if (Math.random() < config.failureRate) {
      const error = DHAN_ERRORS[Math.floor(Math.random() * DHAN_ERRORS.length)];
      console.log(`  🎲 [${config.mode}] Injected ${error.status} on ${req.method} ${req.path}`);
      return res.status(error.status).json(error.body);
    }

    // random mode — pass through (success this time)
    next();
  };
}

/**
 * Utility: wrap a handler so it returns success with optional latency in random mode.
 */
export function randomLatency(config: MockConfig): Promise<void> {
  if (config.mode === "random" && config.maxLatencyMs > 0) {
    const delay = Math.floor(Math.random() * config.maxLatencyMs * 0.5);
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  return Promise.resolve();
}
