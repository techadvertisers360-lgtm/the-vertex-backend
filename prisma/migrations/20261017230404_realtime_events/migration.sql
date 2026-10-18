-- CreateTable
CREATE TABLE `realtime_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `room` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,

    INDEX `realtime_events_deliveredAt_id_idx`(`deliveredAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
