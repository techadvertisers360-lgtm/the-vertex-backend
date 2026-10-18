-- AlterTable
ALTER TABLE `offers` ADD COLUMN `withdrawnAt` DATETIME(3) NULL,
    ADD COLUMN `withdrawnById` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `performance_notes` (
    `id` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `memberId` VARCHAR(191) NULL,
    `sheetId` VARCHAR(191) NULL,
    `fromDate` VARCHAR(191) NOT NULL,
    `toDate` VARCHAR(191) NOT NULL,
    `note` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `performance_notes_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TRIGGER `performance_notes_no_delete` BEFORE DELETE ON `performance_notes` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'performance_notes rows cannot be deleted';
