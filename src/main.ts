import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { CORS_ALLOWED_HEADERS, resolveCorsOrigin } from './common/cors';
import { ROOT_PAGE_HTML } from './root-landing';

async function bootstrap() {
  if (process.env.NODE_ENV === 'production' && !(process.env.ADMIN_INTERNAL_KEY ?? '').trim()) {
    console.error('FATAL: ADMIN_INTERNAL_KEY is required in production.');
    process.exit(1);
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined,
  });
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);
  const prefix = config.get<string>('API_PREFIX', 'api');

  const http = app.getHttpAdapter().getInstance();
  http.get('/', (_req, res) => {
    res.type('html').set('Cache-Control', 'public, max-age=300').send(ROOT_PAGE_HTML);
  });

  app.setGlobalPrefix(prefix);
  app.use(compression());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableCors({
    origin: resolveCorsOrigin(),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: CORS_ALLOWED_HEADERS,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false, // Allow extra fields
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );

  await app.listen(port);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Bankers API running at http://localhost:${port}/${prefix}`);
  }
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
