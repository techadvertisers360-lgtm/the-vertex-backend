-- Procedure product Item IDs are generated in one sequence P-0001, P-0002, ... (D-069).
-- Existing procedure products are renumbered in the order they were added.
UPDATE `stock_items` SET `code` = NULL WHERE `kind` = 'PROCEDURE';
UPDATE `stock_items` s
  JOIN (SELECT `id`, ROW_NUMBER() OVER (ORDER BY `createdAt`, `name`) AS rn FROM `stock_items` WHERE `kind` = 'PROCEDURE') x ON x.`id` = s.`id`
  SET s.`code` = CONCAT('P-', LPAD(x.rn, 4, '0'));
