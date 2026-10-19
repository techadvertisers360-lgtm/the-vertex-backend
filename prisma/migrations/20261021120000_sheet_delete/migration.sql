-- AlterTable
ALTER TABLE `meta_sheets` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedById` VARCHAR(191) NULL;


-- Client 2026-10-19 (D-047): lead sheets are checked every minute. Only an untouched value (the old default 3) moves
-- to 1; a value an admin already changed is kept. The change is written to the audit log like any setting update.
INSERT INTO `audit_events` (`actorId`, `actorRole`, `action`, `recordType`, `recordId`, `before`, `after`, `reason`, `createdAt`)
SELECT NULL, NULL, 'SETTING_UPDATED', 'Setting', 'meta.syncIntervalMin', JSON_OBJECT('value', 3), JSON_OBJECT('value', 1), 'D-047: client asked for an automatic check every minute', CURRENT_TIMESTAMP(3)
FROM `settings` WHERE `key` = 'meta.syncIntervalMin' AND JSON_EXTRACT(`value`, '$') = 3;
UPDATE `settings` SET `value` = CAST('1' AS JSON), `updatedAt` = CURRENT_TIMESTAMP(3)
WHERE `key` = 'meta.syncIntervalMin' AND JSON_EXTRACT(`value`, '$') = 3;
