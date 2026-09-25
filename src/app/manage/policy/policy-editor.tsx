"use client";

import { useState, useTransition } from "react";
import type { Pattern } from "@/server/hotel";
import type { GuardrailRow, Policy } from "@/server/policy";
import { savePolicyAction } from "../actions";

const PATTERN_TABS: { key: Pattern; label: string }[] = [
  { key: "info", label: "案内" },
  { key: "order", label: "オーダー" },
  { key: "external", label: "外部連携" },
  { key: "reservation", label: "予約・客室" },
  { key: "complaint", label: "クレーム" },
];

type EditableGuardrail = Omit<GuardrailRow, "id"> & { id?: string; key: string };
let seq = 0;

export function PolicyEditor({ policy }: { policy: Policy }) {
  const [common, setCommon] = useState(policy.common);
  const [patterns, setPatterns] = useState(policy.patterns);
  const [tab, setTab] = useState<Pattern>("complaint");
  const [guardrails, setGuardrails] = useState<EditableGuardrail[]>(policy.guardrails.map((g) => ({ ...g, key: g.id })));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const touch = () => {
    setDirty(true);
    setMessage(null);
  };

  function add(kind: EditableGuardrail["kind"]) {
    const body = (draft[kind] ?? "").trim();
    if (!body) return;
    setGuardrails((prev) => [...prev, { key: `new-${++seq}`, kind, code: null, body, enabled: true }]);
    setDraft((prev) => ({ ...prev, [kind]: "" }));
    touch();
  }

  function save() {
    startTransition(async () => {
      const result = await savePolicyAction({
        common,
        patterns,
        guardrails: guardrails.map(({ id, kind, body, enabled }) => ({ id, kind, body, enabled })),
      });
      if (result.ok) {
        setDirty(false);
        setMessage({ kind: "ok", text: "保存しました。次の応答から適用され、変更履歴に記録しています。" });
      } else setMessage({ kind: "error", text: result.error });
    });
  }

  const list = (kind: EditableGuardrail["kind"]) => guardrails.filter((g) => g.kind === kind);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {message && <span className={`text-sm ${message.kind === "ok" ? "text-primary" : "text-danger"}`}>{message.text}</span>}
        <button type="button" disabled={!dirty || pending} onClick={save} className="min-h-11 rounded-[10px] bg-primary px-5 text-sm font-bold text-white disabled:opacity-40">
          保存して適用
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 xl:flex-row">
        <section aria-label="指示" className="flex flex-1 flex-col gap-4">
          <div className="flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
            <div className="flex items-center justify-between">
              <label htmlFor="common" className="text-base font-bold">
                共通の指示
              </label>
              <span className="text-xs text-ink-sub">すべての業務に適用</span>
            </div>
            <textarea id="common" rows={4} value={common} onChange={(e) => (setCommon(e.target.value), touch())} className="w-full rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary" />
          </div>
          <div className="flex flex-1 flex-col gap-2.5 rounded-[14px] border border-line bg-surface px-5 py-4.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold">業務ごとの指示</h2>
              <div role="tablist" className="flex gap-1.5">
                {PATTERN_TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={`min-h-10 rounded-lg border px-3.5 text-sm whitespace-nowrap ${tab === t.key ? "border-primary bg-primary-soft font-bold text-primary" : "border-line-input"}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <label htmlFor="task" className="sr-only">
              {PATTERN_TABS.find((t) => t.key === tab)?.label}の指示
            </label>
            <textarea
              id="task"
              rows={8}
              value={patterns[tab]}
              placeholder="この業務だけに適用する指示（例: 補償には触れずに事実を確認し、引き継ぐ）"
              onChange={(e) => (setPatterns((prev) => ({ ...prev, [tab]: e.target.value })), touch())}
              className="w-full flex-1 rounded-[10px] border border-line-input px-3.5 py-3 text-sm leading-relaxed outline-none focus:border-primary"
            />
          </div>
        </section>

        <aside aria-label="ガードレール" className="flex w-full shrink-0 flex-col gap-5 rounded-[14px] border border-line bg-surface px-5.5 py-5 xl:w-[440px]">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-bold">ガードレール</h2>
            <span className="text-xs text-ink-sub">指示より優先され、応答の前後で自動チェックされます</span>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">してはいけないこと</h3>
            {list("forbidden").map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm">
                <span className={g.enabled ? "" : "text-ink-sub line-through"}>{g.body}</span>
                <button type="button" aria-label="この決まりを削除" onClick={() => (setGuardrails((prev) => prev.filter((x) => x.key !== g.key)), touch())} className="min-h-9 w-8 shrink-0 text-ink-sub">
                  ×
                </button>
              </div>
            ))}
            <AddRow value={draft.forbidden ?? ""} onChange={(v) => setDraft((p) => ({ ...p, forbidden: v }))} onAdd={() => add("forbidden")} placeholder="例: 他社のホテルを勧めない" />
          </div>

          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-bold">必ず人に引き継ぐ条件</h3>
            {list("handoff_condition").map((g) => (
              <label key={g.key} className="flex min-h-11 items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={g.enabled}
                  onChange={(e) => (setGuardrails((prev) => prev.map((x) => (x.key === g.key ? { ...x, enabled: e.target.checked } : x))), touch())}
                  className="size-5 accent-primary"
                />
                {g.body}
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-bold">確定前に必ずお客様へ確認</h3>
            {list("confirm_before").map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2 text-sm">
                {g.body}
                <button type="button" aria-label="この項目を削除" onClick={() => (setGuardrails((prev) => prev.filter((x) => x.key !== g.key)), touch())} className="min-h-9 w-8 shrink-0 text-ink-sub">
                  ×
                </button>
              </div>
            ))}
            <AddRow value={draft.confirm_before ?? ""} onChange={(v) => setDraft((p) => ({ ...p, confirm_before: v }))} onAdd={() => add("confirm_before")} placeholder="例: 送迎の手配" />
          </div>
        </aside>
      </div>
    </div>
  );
}

function AddRow({ value, onChange, onAdd, placeholder }: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string }) {
  return (
    <div className="flex gap-2">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-h-10 flex-1 rounded-lg border border-line-input px-3 text-sm outline-none focus:border-primary" />
      <button type="button" disabled={!value.trim()} onClick={onAdd} className="min-h-10 rounded-lg border border-dashed border-[#BDB6AA] px-3 text-sm text-ink-sub disabled:opacity-40">
        ＋ 追加
      </button>
    </div>
  );
}
