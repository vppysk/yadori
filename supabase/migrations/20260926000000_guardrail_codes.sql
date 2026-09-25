-- 必ず人に引き継ぐ条件のうち、アプリが判定を実装している組み込みの条件を識別する（オン・オフは enabled）
alter table guardrails add column code text check (code in ('wants_staff', 'strong_complaint', 'unanswered_twice', 'safety'));
create unique index guardrails_code on guardrails (hotel_id, code) where code is not null;

update guardrails set code = case body
  when 'お客様が「スタッフと話したい」と言った' then 'wants_staff'
  when '強い不満や怒りを検知した' then 'strong_complaint'
  when '同じ質問に2回答えられなかった' then 'unanswered_twice'
  when '急病・けが・安全に関わる内容' then 'safety'
end
where kind = 'handoff_condition';
