/// <reference types="express" />
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import express, { Request, Response } from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { CORS_ALLOWED_HEADERS, resolveCorsOrigin } from '../src/common/cors';
import { ROOT_PAGE_HTML } from '../src/root-landing';

function isRootGet(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const raw = req.url ?? '/';
  const path = (raw.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  return path === '/' || path === '';
}

let cachedApp: express.Express;

async function createApp(): Promise<express.Express> {
  if (cachedApp) {
    return cachedApp;
  }

  if (process.env.NODE_ENV === 'production' && !(process.env.ADMIN_INTERNAL_KEY ?? '').trim()) {
    throw new Error('ADMIN_INTERNAL_KEY is required in production.');
  }
  if (process.env.NODE_ENV === 'production' && !(process.env.PAN_ENCRYPTION_KEY ?? '').trim()) {
    throw new Error('PAN_ENCRYPTION_KEY is required in production.');
  }

  const expressApp = express();
  expressApp.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      hsts:
        process.env.NODE_ENV === 'production'
          ? { maxAge: 15552000, includeSubDomains: true }
          : false,
    }),
  );
  expressApp.use(compression());
  expressApp.set('trust proxy', 1);

  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    bufferLogs: true,
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined,
  });
  const config = app.get(ConfigService);
  const prefix = config.get<string>('API_PREFIX', 'api');

  app.setGlobalPrefix(prefix);

  app.enableCors({
    origin: resolveCorsOrigin(),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: CORS_ALLOWED_HEADERS,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  await app.init();
  cachedApp = expressApp;
  return expressApp;
}

export default async function handler(req: Request, res: Response) {
  try {
    if (isRootGet(req)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
      return res.status(200).send(ROOT_PAGE_HTML);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('API Request:', req.method, req.url);
    }

    const app = await createApp();
    return app(req, res);
  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'production' 
        ? 'An error occurred' 
        : error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
