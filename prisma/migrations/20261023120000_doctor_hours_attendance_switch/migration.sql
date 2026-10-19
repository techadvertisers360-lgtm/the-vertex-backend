-- AlterTable
ALTER TABLE `doctor_profiles` ADD COLUMN `defaultRoomId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `attendanceRequired` BOOLEAN NOT NULL DEFAULT true;

