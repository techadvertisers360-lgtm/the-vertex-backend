import 'dotenv/config';

// Point every module at the test database before any app module is imported.
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOADTHING_TOKEN = '';
process.env.JWT_ACCESS_SECRET ||= 'test-secret-test-secret-test-secret-0123456789';
process.env.WHATSAPP_WEBHOOK_SECRET ||= 'test-webhook-secret';
