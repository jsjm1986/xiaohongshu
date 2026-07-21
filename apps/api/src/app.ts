import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { ApiOptionsInput } from './config.js';

export async function createApplication(options: ApiOptionsInput = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    logger: options.logger === false ? false : ['error', 'warn', 'log'],
    bodyParser: false,
  });
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
    if (process.env.NODE_ENV === 'production') {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.enableShutdownHooks();
  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  const webIndex = resolve(webDist, 'index.html');
  if (existsSync(webIndex)) {
    app.useStaticAssets(webDist, { index: false });
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
        response.sendFile(webIndex);
        return;
      }
      next();
    });
  }
  await app.init();
  return app;
}
