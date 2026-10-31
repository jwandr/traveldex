-- Trip planner: lets a card be placed in a day + time-slot of its destination's trip.
-- Run once in the Supabase SQL editor.

alter table rolodex_cards
  add column if not exists plan_day  integer check (plan_day >= 1),
  add column if not exists plan_slot text    check (plan_slot in ('morning', 'noon', 'afternoon', 'evening'));

-- One card per slot, per destination.
create unique index if not exists rolodex_cards_one_per_slot
  on rolodex_cards (destination_id, plan_day, plan_slot)
  where plan_day is not null and plan_slot is not null;
