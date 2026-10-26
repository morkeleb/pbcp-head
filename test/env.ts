// The suites run against pbcp_test (created by db/init in docker-compose.yml), never the dev database.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://pbcp:pbcp@localhost:5433/pbcp_test';
