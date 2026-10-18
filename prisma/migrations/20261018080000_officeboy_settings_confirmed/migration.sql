-- Client answers 2026-10-18 (CONFIG 11a / 11b): Office Boy round areas and photo-on-issue are confirmed values.
INSERT INTO `settings` (`key`, `value`, `isPlaceholder`, `description`, `updatedAt`)
VALUES (
  'officeBoy.areas',
  JSON_ARRAY('Entrance/Stairs', 'Reception & Waiting', 'Washroom (Male)', 'Washroom (Female)', 'C01', 'C02', 'C03', 'P01', 'P02', 'P03', 'Corridor', 'Store Room', 'Pantry/Kitchen', 'Staff Room'),
  false,
  'Clinic areas on every Office Boy round; the Manager edits this list (client confirmed 2026-10-18).',
  NOW(3)
)
ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `isPlaceholder` = false, `description` = VALUES(`description`), `updatedAt` = NOW(3);

INSERT INTO `settings` (`key`, `value`, `isPlaceholder`, `description`, `updatedAt`)
VALUES ('officeBoy.photoRequiredOnIssue', CAST('true' AS JSON), false, 'A photo is required when an Office Boy round reports a problem (client confirmed 2026-10-18).', NOW(3))
ON DUPLICATE KEY UPDATE `value` = CAST('true' AS JSON), `isPlaceholder` = false, `description` = VALUES(`description`), `updatedAt` = NOW(3);
