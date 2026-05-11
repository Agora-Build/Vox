-- Remove auto-seeded aeval eval sets (names like [aeval v*])
DELETE FROM eval_sets WHERE name LIKE '[aeval v%]';--> statement-breakpoint
-- Remove auto-seeded aeval workflows (names like [aeval v*])
DELETE FROM workflows WHERE name LIKE '[aeval v%]';--> statement-breakpoint
-- Remove auto-seeded aeval projects (names like [aeval v*])
DELETE FROM projects WHERE name LIKE '[aeval v%]';