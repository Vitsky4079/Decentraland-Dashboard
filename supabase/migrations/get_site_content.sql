-- Run this whenever get_site_content changes. Idempotent (create or replace).
create or replace function public.get_site_content()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'announcement', coalesce(
      (select jsonb_build_object('text', a.text, 'level', a.level, 'link', a.link)
         from public.announcements a where a.active and a.text <> '' limit 1),
      '{}'::jsonb),
    'service_status', coalesce(
      (select jsonb_object_agg(s.name, s.level) from public.service_status s),
      '{}'::jsonb),
    'pins', coalesce(
      (select jsonb_agg(p.url order by p.position) from public.pins p),
      '[]'::jsonb),
    'issue_overrides', coalesce(
      (select jsonb_object_agg(i.url, jsonb_strip_nulls(jsonb_build_object(
         'title', i.title, 'summary', i.summary, 'status', i.status,
         'impact', i.impact, 'area', i.area, 'workaround', i.workaround,
         'hidden', case when i.hidden then true else null end)))
         from public.issue_overrides i),
      '{}'::jsonb),
    'patch_notes', coalesce(
      (select jsonb_agg(jsonb_build_object(
         'stream', coalesce(n.stream, 'explorer'),
         'version', n.version, 'date', n.date_label, 'body', n.body)
         order by n.position)
         from public.patch_notes n),
      '[]'::jsonb),
    'announcement_posts', coalesce(
      (select jsonb_agg(jsonb_build_object(
         'id', ap.id, 'title', ap.title, 'body', ap.body,
         'images', ap.images, 'date', ap.post_date)
         order by ap.post_date desc, ap.created_at desc)
         from public.announcement_posts ap),
      '[]'::jsonb)
  );
$$;

grant execute on function public.get_site_content() to anon, authenticated;
