"use client";

import { useOptimistic, useState, useTransition } from "react";
import type { DutySettings, DutyStaff } from "@/server/duties";
import { setDutyAction } from "../../actions";
import { ALL_AREAS, tr } from "@/lib/i18n";

type Duty = DutyStaff["duties"][number];
const same = (a: Duty, b: Duty) => a.job_role_id === b.job_role_id && a.area_id === b.area_id;

// 担当設定（docs/005_order.md 2章）: スタッフごとに担当する役割×エリアを決める。押すとすぐ反映する
export function DutiesEditor({ data }: { data: DutySettings }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // 押した直後に表示を切り替える（サーバーの反映を待たない）
  const [staff, toggleOptimistic] = useOptimistic(data.staff, (list, change: { memberId: string; duty: Duty; on: boolean }) =>
    list.map((s) =>
      s.id !== change.memberId ? s : { ...s, duties: change.on ? [...s.duties, change.duty] : s.duties.filter((d) => !same(d, change.duty)) },
    ),
  );
  const areaChoices = [{ id: null, name: ALL_AREAS }, ...data.areas];

  const toggle = (memberId: string, duty: Duty, on: boolean) =>
    startTransition(async () => {
      toggleOptimistic({ memberId, duty, on });
      const r = await setDutyAction(memberId, duty.job_role_id, duty.area_id, on);
      setError(r.ok ? null : (r.error ?? tr("失敗しました", "Failed")));
    });

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 px-6 py-5.5">
      <div className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold">{tr("担当設定", "Duties")}</h1>
        <p className="text-xs leading-relaxed text-ink-sub">
          {tr(
            "スタッフごとに、担当する役割とエリアを選びます。出勤しているスタッフのうち、オーダーの役割と部屋のエリアを担当している人に割り当てます。エリアの担当がいないときは、全館の担当に割り当てます。出勤・退勤は各自が現場スマホで行います。",
            "Choose each staff member's roles and areas. Orders go to on-shift staff covering the order's role and the room's area; if no one covers the area, hotel-wide staff get it. Staff start and end shifts on their phones.",
          )}
        </p>
      </div>
      {error && <p className="rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-sub">
              <th className="w-48 px-4 py-2.5 font-normal">{tr("スタッフ", "Staff")}</th>
              {data.roles.map((r) => (
                <th key={r.id} className="px-4 py-2.5 font-normal">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-b-0">
                <td className="px-4 py-3 align-top">
                  <div className="flex flex-col gap-1">
                    <strong>{s.name}</strong>
                    <span className="text-xs text-ink-sub">{s.job_title ?? ""}</span>
                    <span className="flex flex-wrap gap-1 text-[11px]">
                      {s.on_shift && <span className="rounded bg-primary-soft px-1.5 py-0.5 font-bold text-primary">{tr("出勤中", "On shift")}</span>}
                      {!s.assignable && (
                        <span className="rounded bg-caution-soft px-1.5 py-0.5 text-caution" title={tr("メンバーと権限で「担当になれる」を付けると割り当てられます", "Grant \"Can be assigned\" in Members & permissions to receive orders")}>
                          {tr("担当になれる権限なし", "Not assignable")}
                        </span>
                      )}
                    </span>
                  </div>
                </td>
                {data.roles.map((r) => (
                  <td key={r.id} className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      {areaChoices.map((a) => {
                        const duty = { job_role_id: r.id, area_id: a.id };
                        const on = s.duties.some((d) => same(d, duty));
                        return (
                          <button
                            key={a.id ?? "all"}
                            type="button"
                            aria-pressed={on}
                            aria-label={tr(`${s.name}の${r.name} ${a.name}`, `${s.name}: ${r.name} ${a.name}`)}
                            disabled={pending}
                            onClick={() => toggle(s.id, duty, !on)}
                            className={`min-h-10 rounded-lg border px-3 text-[13px] ${on ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input text-ink-sub"} ${!s.assignable && on ? "opacity-60" : ""}`}
                          >
                            {a.name}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
