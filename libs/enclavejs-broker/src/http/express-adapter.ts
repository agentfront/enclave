/**
 * Express Adapter for Session Handler
 *
 * Adapter to use SessionHandler with Express.js
 *
 * @packageDocumentation
 */

import type { SessionHandler } from './session-handler';
import type { BrokerRequest, BrokerResponse } from './types';

/**
 * Express-like Request type
 */
interface ExpressRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket?: { destroyed?: boolean };
  on?(event: string, handler: () => void): void;
}

/**
 * Express-like Response type
 */
interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(data: unknown): void;
  setHeader(name: string, value: string): ExpressResponse;
  set(name: string, value: string): ExpressResponse;
  write(data: string): boolean;
  end(): void;
  flushHeaders?(): void;
  flush?(): void;
}

/**
 * Express Router-like interface
 */
interface ExpressRouter {
  get(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  post(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  delete(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  options(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
}

/**
 * Adapt Express request to BrokerRequest
 */
function adaptRequest(req: ExpressRequest): BrokerRequest {
  // Create abort controller for client disconnect handling
  const abortController = new AbortController();

  // Listen for client disconnect
  if (req.on && req.socket) {
    req.on('close', () => {
      if (req.socket?.destroyed) {
        abortController.abort();
      }
    });
  }

  return {
    method: req.method,
    path: req.path,
    params: req.params,
    query: req.query as Record<string, string>,
    body: req.body,
    headers: req.headers,
    signal: abortController.signal,
  };
}

/**
 * Adapt Express response to BrokerResponse
 */
function adaptResponse(res: ExpressResponse): BrokerResponse {
  return {
    status(code: number) {
      res.status(code);
      return this;
    },
    json(data: unknown) {
      res.json(data);
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
      return this;
    },
    write(data: string) {
      res.write(data);
    },
    end() {
      res.end();
    },
    flush() {
      if (res.flushHeaders) {
        res.flushHeaders();
      }
      if (res.flush) {
        res.flush();
      }
    },
  };
}

/**
 * Create an Express router from SessionHandler
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { createBroker, createSessionHandler, createExpressRouter } from '@enclavejs/broker';
 *
 * const broker = createBroker();
 * const handler = createSessionHandler({ broker });
 * const router = createExpressRouter(handler);
 *
 * const app = express();
 * app.use('/api', router);
 * ```
 */
export function createExpressRouter(handler: SessionHandler): ExpressRouter {
  // We return a minimal router interface that can be used with Express
  // The actual router creation happens when the caller uses this with Express
  const routes: Array<{
    method: 'get' | 'post' | 'delete' | 'options';
    path: string;
    handler: (req: ExpressRequest, res: ExpressResponse) => void;
  }> = [];

  for (const route of handler.getRoutes()) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete' | 'options';
    routes.push({
      method,
      path: route.path,
      handler: (req: ExpressRequest, res: ExpressResponse) => {
        const brokerReq = adaptRequest(req);
        const brokerRes = adaptResponse(res);
        route.handler(brokerReq, brokerRes).catch((error) => {
          console.error('Route handler error:', error);
          if (!res.setHeader) return;
          res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          });
        });
      },
    });
  }

  // Return a registrar function that takes an Express router
  return {
    get(path, routeHandler) {
      const route = routes.find((r) => r.method === 'get' && r.path === path);
      if (route) routeHandler = route.handler;
    },
    post(path, routeHandler) {
      const route = routes.find((r) => r.method === 'post' && r.path === path);
      if (route) routeHandler = route.handler;
    },
    delete(path, routeHandler) {
      const route = routes.find((r) => r.method === 'delete' && r.path === path);
      if (route) routeHandler = route.handler;
    },
    options(path, routeHandler) {
      const route = routes.find((r) => r.method === 'options' && r.path === path);
      if (route) routeHandler = route.handler;
    },
  };
}

/**
 * Register SessionHandler routes on an Express router
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { createBroker, createSessionHandler, registerExpressRoutes } from '@enclavejs/broker';
 *
 * const broker = createBroker();
 * const handler = createSessionHandler({ broker });
 *
 * const app = express();
 * app.use(express.json());
 * registerExpressRoutes(app, handler);
 *
 * app.listen(3000);
 * ```
 */
export function registerExpressRoutes(router: ExpressRouter, handler: SessionHandler): void {
  for (const route of handler.getRoutes()) {
    const method = route.method.toLowerCase() as 'get' | 'post' | 'delete' | 'options';
    const expressHandler = (req: ExpressRequest, res: ExpressResponse) => {
      const brokerReq = adaptRequest(req);
      const brokerRes = adaptResponse(res);
      route.handler(brokerReq, brokerRes).catch((error) => {
        console.error('Route handler error:', error);
        try {
          res.status(500).json({
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          });
        } catch {
          // Response may already be sent
        }
      });
    };

    router[method](route.path, expressHandler);
  }
}
