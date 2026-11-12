-- At rest, deploy 2 (docs/deploy.md "At rest"): the plaintext columns go. The point of no return: from here on the
-- content is readable only with HEAD_MASTER_KEY. It refuses to run while any row still holds content only in plaintext
-- (`pnpm encrypt-backfill --verify` reports zero first); the migrator runs it in one transaction, so a refusal changes nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cards WHERE content IS NULL OR NOT content ? 'doc' OR NOT content ? 'mac'
      OR (rendered_html IS NOT NULL AND NOT content ? 'html') OR (rendered_actions IS NOT NULL AND NOT content ? 'actions')
      OR (rendered_meta IS NOT NULL AND NOT content ? 'meta') OR (rendered_paragraph IS NOT NULL AND NOT content ? 'paragraph')
      OR (comment IS NOT NULL AND NOT content ? 'comment') OR (edited_proposal IS NOT NULL AND NOT content ? 'edited')
      OR (decided_doc IS NOT NULL AND NOT content ? 'decided' AND EXISTS (
        SELECT 1 FROM jsonb_object_keys(decided_doc) AS k
        WHERE k NOT IN ('protocol', 'id', 'kind', 'to_person', 'producer', 'urgency', 'sensitivity', 'thread', 'about', 'at', 'until', 'references', 'supersedes', 'emitted_at', 'orders.claim_seq', 'orders.result')))
  ) OR EXISTS (SELECT 1 FROM decision_log WHERE content IS NULL OR NOT content ? 'doc')
    OR EXISTS (SELECT 1 FROM diagrams WHERE content IS NULL AND (svg IS NOT NULL OR error IS NOT NULL OR svg_dark IS NOT NULL OR error_dark IS NOT NULL))
  THEN
    RAISE EXCEPTION 'rows still hold content only in plaintext: deploy the release with migration 0022 and run `pnpm encrypt-backfill` (with HEAD_MASTER_KEY set) until `--verify` reports zero, then migrate again';
  END IF;
END $$;--> statement-breakpoint
-- The producer documents keep only their clear fields (lib/vault.ts CLEAR_FIELDS); the rest is sealed in `content`.
CREATE FUNCTION pg_temp.pbcp_clear(doc jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(doc) AS e(k, v)
  WHERE k IN ('protocol', 'id', 'kind', 'to_person', 'producer', 'urgency', 'sensitivity', 'thread', 'about', 'at', 'until', 'references', 'supersedes', 'emitted_at', 'orders.claim_seq', 'orders.result')
$$;--> statement-breakpoint
UPDATE cards SET producer_doc = pg_temp.pbcp_clear(producer_doc) WHERE producer_doc <> pg_temp.pbcp_clear(producer_doc);--> statement-breakpoint
UPDATE cards SET decided_doc = pg_temp.pbcp_clear(decided_doc) WHERE decided_doc IS NOT NULL AND decided_doc <> pg_temp.pbcp_clear(decided_doc);--> statement-breakpoint
UPDATE decision_log SET decided_doc = pg_temp.pbcp_clear(decided_doc) WHERE decided_doc <> pg_temp.pbcp_clear(decided_doc);--> statement-breakpoint
-- Diagrams drawn before the cache was per head: copied, sealed, to the heads that show them by the backfill.
DELETE FROM diagrams WHERE content = '{"migrated": true}'::jsonb;--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "edited_proposal";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "comment";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "rendered_html";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "rendered_actions";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "rendered_meta";--> statement-breakpoint
ALTER TABLE "cards" DROP COLUMN "rendered_paragraph";--> statement-breakpoint
ALTER TABLE "decision_log" DROP COLUMN "edited_proposal";--> statement-breakpoint
ALTER TABLE "decision_log" DROP COLUMN "comment";--> statement-breakpoint
ALTER TABLE "diagrams" DROP COLUMN "svg";--> statement-breakpoint
ALTER TABLE "diagrams" DROP COLUMN "error";--> statement-breakpoint
ALTER TABLE "diagrams" DROP COLUMN "svg_dark";--> statement-breakpoint
ALTER TABLE "diagrams" DROP COLUMN "error_dark";
