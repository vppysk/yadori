// 館内の情報の値（docs/002_facility_master_design.md）。型はなく、タイトル（任意）＋本文（自由文）＋期間（終了日なし可）。
// 期間の重なりは、同じ施設・項目・タイトルの値同士で、承認時にスタッフが選んだ優先度（大きい方が優先）で決める。
// DBに依存しない関数だけを置く（管理PCの確認画面でも使う）

export type InfoValue = {
  id: string;
  title: string | null;
  body: string;
  from: string;
  // null は終了日なし（以降ずっと）
  to: string | null;
  priority: number;
  sourceTitle: string | null;
  // 管理主体がホテルの外にある資料から読み取った値（docs/006_guide_info.md）
  external?: boolean;
};

export type FieldWithValues<V = InfoValue> = { fieldId: string; name: string; values: V[] };

const FAR = "9999-12-31";

// "[2026-04-01,2026-10-15)" や "[2026-04-01,)" → 両端を含む日付（終了日なしは null）
export function parseValidRange(range: string): { from: string; to: string | null } {
  const match = range.match(/^([[(])([^,]*),([^)\]]*)([)\]])$/);
  if (!match) throw new Error(`daterange を解釈できません: ${range}`);
  const [, lower, from, to, upper] = match;
  return {
    from: lower === "(" ? addDays(from, 1) : from,
    to: !to || to === "infinity" ? null : upper === ")" ? addDays(to, -1) : to,
  };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Period = { from: string; to: string | null };

export const overlaps = (a: Period, b: Period) => a.from <= (b.to ?? FAR) && b.from <= (a.to ?? FAR);

export const periodText = (p: Period) => (p.to === p.from ? `${p.from}のみ` : `${p.from}〜${p.to ?? "（終了日なし）"}`);

// 重なりを比べる単位: 同じ項目で、タイトルが同じ（空白と全角半角の違いは無視）
export const titleKey = (title: string | null) => (title ?? "").normalize("NFKC").replace(/\s+/g, "");

// AIに渡す1行。期間は必ず付ける（滞在日で答え分けるため）。外部情報は出どころを付ける（案内で「○○によると」と添えさせる）
export function describeValue(fieldName: string, v: { title: string | null; body: string; external?: boolean; sourceTitle?: string | null } & Period): string {
  const head = v.title ? `${fieldName}「${v.title}」` : fieldName;
  const origin = v.external ? `（外部情報: ${v.sourceTitle ?? "外部の資料"}）` : "";
  return `${head}: ${v.body || "（内容の記載なし）"}（適用期間 ${periodText(v)}）${origin}`;
}

// 値ごとに、同じタイトルでより優先される値に覆われていない期間を返す（覆われた部分は案内に使わない）。
// 例: 通常「ランチ 11:30〜」(4/1〜) と冬季「ランチ 休業」(10/15〜3/31、優先) → 通常は 4/1〜10/14 と 4/1〜 に分かれる
export function effectivePeriods<V extends { title: string | null; priority: number } & Period>(values: V[]): (V & { overriddenBy: V[] })[] {
  const result: (V & { overriddenBy: V[] })[] = [];
  for (const v of values) {
    const stronger = values.filter((w) => w !== v && titleKey(w.title) === titleKey(v.title) && w.priority > v.priority && overlaps(v, w));
    let segments: Period[] = [{ from: v.from, to: v.to }];
    for (const w of stronger) {
      segments = segments.flatMap((s) => {
        if (!overlaps(s, w)) return [s];
        const parts: Period[] = [];
        if (s.from < w.from) parts.push({ from: s.from, to: addDays(w.from, -1) });
        if (w.to !== null && (s.to === null || s.to > w.to)) parts.push({ from: addDays(w.to, 1), to: s.to });
        return parts;
      });
    }
    for (const s of segments) result.push({ ...v, ...s, overriddenBy: stronger });
  }
  return result;
}

// ---------- 名前の照合（施設・項目） ----------

export const normName = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

// 完全一致 → 空白・全角半角を無視した一致 → 部分一致（1件に絞れるときだけ）。
// LLMに照合させず、コードで決める（品目の matchCatalog と同じ考え方）
export function matchName<T extends { name: string }>(items: T[], name: string): T | undefined {
  const n = normName(name);
  if (!n) return undefined;
  const exact = items.find((x) => x.name === name) ?? items.find((x) => normName(x.name) === n);
  if (exact) return exact;
  const partial = items.filter((x) => normName(x.name).includes(n) || n.includes(normName(x.name)));
  return partial.length === 1 ? partial[0] : undefined;
}

// 資料の行の施設の指し方: 既存の施設は "id:<施設ID>"、まだない施設は "name:<資料での名前>"
export const facilityRef = { id: (id: string) => `id:${id}`, name: (name: string) => `name:${name}` };
export const parseFacilityRef = (ref: string) =>
  ref.startsWith("id:") ? { kind: "existing" as const, id: ref.slice(3) } : { kind: "new" as const, name: ref.replace(/^name:/, "") };

// 項目名 → 既存の項目ならそのID、なければ "new:<正規化した名前>"（重なりの判定に使う）
export function fieldKey(fields: { id: string; name: string }[], name: string): string {
  const n = normName(name);
  return fields.find((f) => normName(f.name) === n)?.id ?? `new:${n}`;
}

// 資料の行を重なりの判定に使う形にする（施設は ref、項目は既存のIDか "new:<名前>"）。確認画面と承認で同じものを使う
export function toCandidates(
  rows: { key: string; facility: string; field: string; title: string | null; from: string; to: string | null }[],
  fields: { id: string; name: string }[],
) {
  return rows.map((r) => ({ key: r.key, facilityId: r.facility, fieldId: fieldKey(fields, r.field), title: r.title, from: r.from, to: r.to }));
}

// ---------- 承認時の重なりの確認 ----------

// 新しく承認する値（key で識別）と、承認済みの値・同じ資料の他の値との重なり
export type Conflict = { key: string; a: string; b: string };
type Candidate = { key: string; facilityId: string; fieldId: string; title: string | null } & Period;

export function findConflicts(rows: Candidate[], existing: Candidate[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const same = (x: Candidate, y: Candidate) =>
    x.facilityId === y.facilityId && x.fieldId === y.fieldId && titleKey(x.title) === titleKey(y.title) && overlaps(x, y);
  rows.forEach((r, i) => {
    for (const e of existing) if (same(r, e)) conflicts.push({ key: `${r.key}|${e.key}`, a: r.key, b: e.key });
    for (const o of rows.slice(i + 1)) if (same(r, o)) conflicts.push({ key: `${r.key}|${o.key}`, a: r.key, b: o.key });
  });
  return conflicts;
}

// 選ばれた勝ち負け（winner: 各重なりで優先する側の key）から、新しい値の優先度を決める。
// 承認済みの値の優先度は変えず、その間に入る値を選ぶ。新しい値同士は、負けた側から順に、置ける範囲のできるだけ下に置く。
// 選び方が矛盾していれば（A＞B、B＞C、C＞A など）null
export function assignPriorities(
  rows: { key: string }[],
  existingPriority: Map<string, number>,
  conflicts: Conflict[],
  winner: Record<string, string>,
): Map<string, number> | null {
  const priority = new Map(existingPriority);
  const edges = conflicts.map((c) => ({ win: winner[c.key], lose: winner[c.key] === c.a ? c.b : c.a }));
  const pending = new Set(rows.map((r) => r.key));
  while (pending.size > 0) {
    // まだ決まっていない新しい値に負けていないものから決める
    const next = [...pending].find((key) => !edges.some((e) => e.win === key && pending.has(e.lose)));
    if (!next) return null;
    const lower = Math.max(-Infinity, ...edges.filter((e) => e.win === next).map((e) => priority.get(e.lose)!));
    const upper = Math.min(Infinity, ...edges.filter((e) => e.lose === next && priority.has(e.win)).map((e) => priority.get(e.win)!));
    if (lower >= upper) return null;
    priority.set(
      next,
      lower === -Infinity ? (upper === Infinity ? 0 : upper - 1) : upper === Infinity ? lower + 1 : lower + (upper - lower) / (pending.size + 1),
    );
    pending.delete(next);
  }
  return edges.every((e) => priority.get(e.win)! > priority.get(e.lose)!) ? priority : null;
}
