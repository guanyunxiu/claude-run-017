import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CollaborationGateway } from './collaboration/collaboration.gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 8080);
  const corsRaw = config.get<string>(
    'CORS_ORIGIN',
    'http://localhost:5173,http://localhost:8080',
  );
  const origins = corsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: origins,
    credentials: true,
  });

  const httpServer = app.getHttpServer();

  // Attach the binary y-websocket-compatible gateway to the same HTTP server.
  const gateway = app.get(CollaborationGateway);
  gateway.attach(httpServer, '/collab');
  // Note: registerConnectionHandler must run before any upgrade completes.
  gateway.registerConnectionHandler();

  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Bootstrap');
  logger.log(`API listening on http://0.0.0.0:${port}/api`);
  logger.log(`Collaboration WS listening on ws://0.0.0.0:${port}/collab/:documentId`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', err);
  process.exit(1);
});
