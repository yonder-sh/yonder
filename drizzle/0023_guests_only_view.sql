-- Link guests only view (owner, 2026-10-09): only members change things. Open
-- suggestions a guest made before are withdrawn, with whatever builds on them.
WITH RECURSIVE dep(id) AS (
	SELECT id FROM proposals WHERE status = 'open' AND author_is_guest
	UNION
	SELECT p.id FROM proposals p JOIN dep d ON d.id = ANY(p.requires) WHERE p.status = 'open'
)
UPDATE proposals
   SET status = 'withdrawn', review_note = 'guests only view now', updated_at = now()
 WHERE id IN (SELECT id FROM dep);
