import type { CatalogItem } from "./orders";

// ゲストの言い方を品目マスタに当てる（docs/005_order.md 2章）。LLMには照合させない:
// 別名にある品をマスタにないと判断したり、ない品を既存の品目に当てはめたりした（2026-09-25 検証）。
// 候補は広めに出し、最後はゲストが選択欄で品目と数量を選ぶ

export type RequestedLine = { label: string; quantity: number };

export type OrderCandidates = {
  // 選択欄に出す品目と初期の数量。品目が1つに決まらないときは0（ゲストが選ぶ）。同じ分類の品も0で並べる
  lines: { itemId: string; quantity: number }[];
  // 品目マスタにない依頼（ゲストの言い方）
  unsupported: string[];
  // 頼まれた品がすべて一時品切れだったもの（品目名）
  paused: string[];
};

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
// 英語の複数形（towels・brushes）を単数にする。日本語には効かない
const singular = (s: string) => s.replace(/(ches|shes|sses|xes)$/, (m) => m.slice(0, -2)).replace(/(?<!s)s$/, "");

export function matchCatalog(requested: RequestedLine[], catalog: CatalogItem[]): OrderCandidates {
  const quantities = new Map<string, number>();
  const add = (item: CatalogItem, quantity: number) => quantities.set(item.id, Math.max(quantities.get(item.id) ?? 0, quantity));
  const unsupported: string[] = [];
  const paused = new Set<string>();
  const words = (c: CatalogItem) => [c.name, ...c.aliases].map(norm).filter(Boolean);

  for (const line of requested) {
    const label = norm(line.label);
    if (!label) continue;
    // 1. 品目名・別名と一致 → 2. 分類に当たる（「タオル」→タオルの品すべて）→ 3. 品目名・別名と部分一致
    let hits = catalog.filter((c) => words(c).includes(label) || words(c).includes(singular(label)));
    if (hits.length === 0) {
      hits = catalog.filter((c) => {
        const category = norm(c.category);
        return category === label || label.includes(category) || category.includes(label);
      });
    }
    if (hits.length === 0) hits = catalog.filter((c) => words(c).some((w) => label.includes(w) || w.includes(label)));
    if (hits.length === 0) {
      unsupported.push(line.label.trim());
      continue;
    }
    const available = hits.filter((c) => c.status === "available");
    // すべて品切れなら選択欄には出さない（同じ分類の別の品を並べても、頼まれた品の代わりになるとは限らない）
    if (available.length === 0) {
      hits.forEach((c) => paused.add(c.name));
      continue;
    }
    // 取り扱い中の品が1つに決まるときだけ数量を入れる
    const single = available.length === 1 ? available[0] : undefined;
    for (const hit of hits) add(hit, hit === single ? line.quantity : 0);
    for (const category of new Set(hits.map((h) => h.category))) {
      for (const sibling of catalog.filter((c) => c.category === category)) add(sibling, 0);
    }
  }

  // 並びは品目マスタの順（分類ごとにまとまる）
  const lines = catalog.filter((c) => quantities.has(c.id)).map((c) => ({ itemId: c.id, quantity: quantities.get(c.id)! }));
  return { lines, unsupported, paused: [...paused] };
}
