-- Fix: previous migration pattern required ] at end of name
-- Actual names: [aeval v0.1.4] interrupt_I00_en (] is in middle)
DELETE FROM eval_sets WHERE name LIKE '[aeval v%';--> statement-breakpoint
DELETE FROM workflows WHERE name LIKE '[aeval v%';--> statement-breakpoint
DELETE FROM projects WHERE name LIKE '[aeval v%';