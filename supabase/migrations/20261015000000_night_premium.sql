-- 時間帯ごとの割増を廃止し、法定の深夜割増（22〜5時、25%以上。労働基準法37条4項）だけを持つ（2026-09-29）
-- 夕方などの法定外の割増は持たない。時間帯の割増率は、帯のうち22〜5時にかかる割合から計算する（dashboard.ts）
alter table hotels add column night_premium_rate numeric(4, 3) not null default 0.25 check (night_premium_rate >= 0.25 and night_premium_rate <= 1);
alter table time_bands drop column wage_multiplier;

-- デモ用ホテルの深夜を法定の深夜（22〜5時）に合わせ、空いた5〜7時は日中に入れる
update time_bands set ends_at = '05:00' where hotel_id = '00000000-0000-0000-0000-000000000001' and name = '深夜';
update time_bands set starts_at = '05:00' where hotel_id = '00000000-0000-0000-0000-000000000001' and name = '日中';
