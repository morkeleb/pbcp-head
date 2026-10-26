// The suites run against pbcp_test (created by db/init in docker-compose.yml), never the dev database.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pbcp:pbcp@localhost:5433/pbcp_test';

/** Signs test sessions; the head under test is started with the same value. */
export const TEST_SESSION_SECRET = 'test-session-secret-not-for-production-0123456789';
export const TEST_HEAD_PORT = Number(process.env.TEST_HEAD_PORT ?? 3107);

/** Stands in for appleid.apple.com's key set in test/http/auth.test.ts. */
export const TEST_APPLE_PORT = Number(process.env.TEST_APPLE_PORT ?? 3108);
export const TEST_APPLE_CLIENT_ID = 'test.head.client';
