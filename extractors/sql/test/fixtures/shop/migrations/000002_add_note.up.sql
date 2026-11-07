ALTER TABLE orders ADD COLUMN note TEXT;
/* CREATE TABLE commented_out (id INT); */
CREATE TABLE `audit_log` (`id` BIGINT AUTO_INCREMENT, `msg` TEXT, KEY idx_msg (`msg`(10)));
