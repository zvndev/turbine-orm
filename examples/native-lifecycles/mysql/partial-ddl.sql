-- Deliberately fails after two committed statements. Disposable databases only.
-- UP
CREATE TABLE partial_items (id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO partial_items (id) VALUES (1);
INSERT INTO partial_items (id) VALUES (1);

-- DOWN
DROP TABLE partial_items;
