-- AlterTable
ALTER TABLE `leads` ADD COLUMN `sheetRowNumber` INTEGER NULL;

-- AlterTable
ALTER TABLE `meta_sheets` ADD COLUMN `columnMap` JSON NULL,
    ADD COLUMN `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `googleSheetId` VARCHAR(191) NULL,
    ADD COLUMN `lastSyncAt` DATETIME(3) NULL,
    ADD COLUMN `lastSyncAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `lastSyncError` TEXT NULL,
    ADD COLUMN `lastSyncStatus` ENUM('SUCCESS', 'FAILED') NULL,
    ADD COLUMN `syncCursorRow` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `syncLeaseOwner` VARCHAR(191) NULL,
    ADD COLUMN `syncLeaseUntil` DATETIME(3) NULL,
    ADD COLUMN `tabName` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `sheet_sync_runs` (
    `id` VARCHAR(191) NOT NULL,
    `sheetId` VARCHAR(191) NOT NULL,
    `trigger` ENUM('SCHEDULED', 'MANUAL') NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `workerId` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `status` ENUM('SUCCESS', 'FAILED') NOT NULL,
    `fromRow` INTEGER NULL,
    `toRow` INTEGER NULL,
    `rowsRead` INTEGER NOT NULL DEFAULT 0,
    `imported` INTEGER NOT NULL DEFAULT 0,
    `alreadyImported` INTEGER NOT NULL DEFAULT 0,
    `duplicatePhones` INTEGER NOT NULL DEFAULT 0,
    `skipped` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `details` JSON NULL,

    INDEX `sheet_sync_runs_sheetId_startedAt_idx`(`sheetId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `meta_sheets_googleSheetId_tabName_key` ON `meta_sheets`(`googleSheetId`, `tabName`);

-- AddForeignKey
ALTER TABLE `sheet_sync_runs` ADD CONSTRAINT `sheet_sync_runs_sheetId_fkey` FOREIGN KEY (`sheetId`) REFERENCES `meta_sheets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Sync log rows are history: never edited or deleted (CLAUDE.md lock 9).
CREATE TRIGGER `sheet_sync_runs_no_update` BEFORE UPDATE ON `sheet_sync_runs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sheet_sync_runs rows cannot be updated';
CREATE TRIGGER `sheet_sync_runs_no_delete` BEFORE DELETE ON `sheet_sync_runs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sheet_sync_runs rows cannot be deleted';

-- Client decision 2026-10-18 (D-039): Meta lead sheets sync from Google Sheets every 3 minutes; alert after 3 failures in a row.
INSERT INTO `settings` (`key`, `value`, `isPlaceholder`, `description`, `updatedAt`)
VALUES ('meta.syncMethod', CAST('"google_sheets"' AS JSON), false, 'Meta lead sheet integration method. §26 #5 — client chose Google Sheets sync (2026-10-18, D-039); "manual" pauses the scheduled sync.', NOW(3))
ON DUPLICATE KEY UPDATE `value` = CAST('"google_sheets"' AS JSON), `isPlaceholder` = false, `description` = VALUES(`description`), `updatedAt` = NOW(3);

INSERT INTO `settings` (`key`, `value`, `isPlaceholder`, `description`, `updatedAt`)
VALUES ('meta.syncIntervalMin', CAST('3' AS JSON), false, 'Minutes between scheduled Google Sheets syncs per assigned sheet (client 2026-10-18, D-039).', NOW(3))
ON DUPLICATE KEY UPDATE `isPlaceholder` = false, `description` = VALUES(`description`), `updatedAt` = NOW(3);

INSERT INTO `settings` (`key`, `value`, `isPlaceholder`, `description`, `updatedAt`)
VALUES ('meta.syncFailureAlertAfter', CAST('3' AS JSON), false, 'Alert Hamza Zafar and Muaz Tahir after this many failed syncs in a row on one sheet (client 2026-10-18, D-039).', NOW(3))
ON DUPLICATE KEY UPDATE `isPlaceholder` = false, `description` = VALUES(`description`), `updatedAt` = NOW(3);
