"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = handler;
const core_1 = require("@nestjs/core");
const platform_express_1 = require("@nestjs/platform-express");
const app_module_1 = require("../src/app.module");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const express_1 = __importDefault(require("express"));
const compression_1 = __importDefault(require("compression"));
let cachedApp;
async function createApp() {
    if (cachedApp) {
        return cachedApp;
    }
    const expressApp = (0, express_1.default)();
    expressApp.use((0, compression_1.default)());
    expressApp.set('trust proxy', 1);
    const app = await core_1.NestFactory.create(app_module_1.AppModule, new platform_express_1.ExpressAdapter(expressApp), {
        bufferLogs: true,
        logger: process.env.NODE_ENV === 'production' ? ['error', 'warn', 'log'] : undefined,
    });
    const config = app.get(config_1.ConfigService);
    const prefix = config.get('API_PREFIX', 'api');
    app.setGlobalPrefix(prefix);
    const isProduction = process.env.NODE_ENV === 'production';
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
    app.enableCors({
        origin: isProduction && allowedOrigins?.length ? allowedOrigins : '*',
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
        allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        stopAtFirstError: false,
    }));
    await app.init();
    cachedApp = expressApp;
    return expressApp;
}
async function handler(req, res) {
    try {
        if (process.env.NODE_ENV !== 'production') {
            console.log('API Request:', req.method, req.url);
            console.log('Request path:', req.path);
            console.log('Request query:', req.query);
        }
        const app = await createApp();
        return app(req, res);
    }
    catch (error) {
        console.error('Handler error:', error);
        res.status(500).json({
            error: 'Internal Server Error',
            message: process.env.NODE_ENV === 'production'
                ? 'An error occurred'
                : error instanceof Error ? error.message : 'Unknown error',
        });
    }
}
//# sourceMappingURL=index.js.map