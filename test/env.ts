// The suites run against pbcp_test (created by db/init in docker-compose.yml), never the dev database.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pbcp:pbcp@localhost:5433/pbcp_test';

/** Signs test sessions; the head under test is started with the same value. */
export const TEST_SESSION_SECRET = 'test-session-secret-not-for-production-0123456789';
export const TEST_HEAD_PORT = Number(process.env.TEST_HEAD_PORT ?? 3107);

/** Stands in for appleid.apple.com's key set in test/http/auth.test.ts. */
export const TEST_APPLE_PORT = Number(process.env.TEST_APPLE_PORT ?? 3108);
export const TEST_APPLE_CLIENT_ID = 'test.head.client';

export const TEST_CRON_SECRET = 'test-cron-secret';

/** The head under test's VAPID pair (lib/push/send.ts), made for the tests with `npx web-push generate-vapid-keys`. */
export const TEST_VAPID_PUBLIC_KEY = 'BHBeDwg4rGv_GDQREyqpFipDmeGVxOaJ0EdHSa7f6b9yR9oFNxuRCQJi-hA189Ycs8CXtKqeST5QG803b9R9ABE';
export const TEST_VAPID_PRIVATE_KEY = 'U1OL_qEcONI7WKuY-ySoKgqWnx4vmmmF1Sg5B6cKckk';
