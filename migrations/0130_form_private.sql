-- A private form is its creator's alone: nobody else in the agency sees it in their list, opens it to edit it,
-- reads its entries or sends it, owners included. Separate from invite_only, which is about who can open the form
-- from its address. 0 is the ordinary form every advisor in the agency can see.
ALTER TABLE forms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
