-- Event-Bild (Banner) je Event + öffentlicher Storage-Bucket. Additiv, CORE unberührt.
alter table public.events add column if not exists image_url text;

-- Öffentlich lesbarer Bucket für Event-Bilder
insert into storage.buckets (id, name, public)
values ('event-images', 'event-images', true)
on conflict (id) do update set public = true;

-- Öffentliches Lesen
drop policy if exists "event_images_public_read" on storage.objects;
create policy "event_images_public_read" on storage.objects for select
  to public using (bucket_id = 'event-images');

-- Schreiben nur für eingetragene Admins/Veranstalter (public.admins)
drop policy if exists "event_images_admin_write" on storage.objects;
create policy "event_images_admin_write" on storage.objects for all
  to authenticated
  using (bucket_id = 'event-images'
         and exists(select 1 from public.admins a where a.email = lower(coalesce(auth.jwt()->>'email',''))))
  with check (bucket_id = 'event-images'
         and exists(select 1 from public.admins a where a.email = lower(coalesce(auth.jwt()->>'email',''))));
