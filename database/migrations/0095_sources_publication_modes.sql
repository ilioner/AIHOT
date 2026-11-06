ALTER TABLE sources ADD CONSTRAINT sources_publication_modes_check CHECK (participation_mode IN ('editorial', 'hot_signal')) NOT VALID;
