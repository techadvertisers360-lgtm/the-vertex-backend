-- Daily cash closing is a signed-off record: never edited after sign-off (spec §14, D-037).
CREATE TRIGGER `cash_closings_no_update` BEFORE UPDATE ON `cash_closings` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'cash_closings rows cannot be updated';
