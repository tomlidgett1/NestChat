-- Add use_linq flag to user_profiles for admin to switch users between Sendblue and Linq providers
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS use_linq boolean NOT NULL DEFAULT false;
