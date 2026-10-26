-- AlterTable
ALTER TABLE `users` ADD COLUMN `geofenceRequired` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `geoLastCheckAt` DATETIME(3) NULL,
    ADD COLUMN `geoLastInside` BOOLEAN NULL,
    ADD COLUMN `geoLastDistanceM` INTEGER NULL;

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `geoClaimUntil` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `geofence_config` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `latitude` DOUBLE NOT NULL DEFAULT 31.5020747,
    `longitude` DOUBLE NOT NULL DEFAULT 74.4335575,
    `radiusM` INTEGER NOT NULL DEFAULT 200,
    `allowedIps` TEXT NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
