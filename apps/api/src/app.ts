import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { resolveOptions, type ApiOptionsInput } from './config.js';

export interface ApplicationLifecycleOptions {
  enableShutdownHooks?: boolean;
}

export async function createApplication(
  options: ApiOptionsInput = {},
  lifecycle: ApplicationLifecycleOptions = {},
): Promise<NestExpressApplication> {
  const resolvedOptions = resolveOptions(options);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(resolvedOptions), {
    logger: resolvedOptions.logger ? ['error', 'warn', 'log'] : false,
    bodyParser: false,
  });
  // The production tunnel connects from loopback. Trust only that directly
  // connected proxy so LAN clients cannot spoof X-Forwarded-For themselves.
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  app.use(json({ limit: '3mb' }));
  app.use(urlencoded({ extended: false, limit: '64kb' }));
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (resolvedOptions.production) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  if (lifecycle.enableShutdownHooks !== false) app.enableShutdownHooks();
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const webIndex = resolve(webDist, 'index.html');
  if (existsSync(webIndex)) {
    // Hashed assets are immutable, but the SPA shell must never stay stale across
    // deployments: an old index.html would keep importing chunks removed by the
    // next Vite build and can strand an open tab in the global ErrorBoundary.
    app.useStaticAssets(webDist, {
      index: false,
      setHeaders: (response, path) => {
        if (path.endsWith('index.html')) response.setHeader('Cache-Control', 'no-store');
        else if (path.includes('/assets/')) response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.getHttpAdapter().getInstance().use((request: Request, response: Response, next: NextFunction) => {
      if (
        request.method === 'GET' &&
        request.accepts('html') &&
        request.path !== '/api' &&
        !request.path.startsWith('/api/') &&
        request.path !== '/v1' &&
        !request.path.startsWith('/v1/') &&
        request.path !== '/health' &&
        !request.path.split('/').at(-1)?.includes('.')
      ) {
        response.setHeader('Cache-Control', 'no-store');
        response.sendFile(webIndex);
        return;
      }
      next();
    });
  }
  await app.init();
  return app;
}
