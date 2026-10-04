// 表示言語の切り替え（NEXT_PUBLIC_APP_LOCALE=en で英語。既定は日本語）。
// 画面の文言・ゲストへの定型文・AIの出力言語・日付の表記をまとめて切り替える。クライアントでも同じ値（ビルド時に埋め込み）
export type Locale = "ja" | "en";

export const LOCALE: Locale = process.env.NEXT_PUBLIC_APP_LOCALE === "en" ? "en" : "ja";
export const isEn = LOCALE === "en";

// 日本語と英語を並べて書き、表示言語の方を返す
export function tr(ja: string, en: string): string {
  return isEn ? en : ja;
}

// 数に応じた英語の単複（日本語は ja をそのまま返す）
export function trCount(n: number, ja: string, enOne: string, enMany: string = `${enOne}s`): string {
  return isEn ? `${n} ${n === 1 ? enOne : enMany}` : ja;
}

// AIへの指示に付ける出力言語の指定
export function outputLanguage(): string {
  return isEn
    ? "Write every piece of text you output (replies, summaries, titles, reasons) in English, even if the input or these instructions are in Japanese. The only exception is a field that asks you to quote the source text verbatim: copy those exactly as written."
    : "出力する文章はすべて日本語で書く。";
}

// 部屋の表示（「1203号室」/「Room 1203」）
export function roomLabel(room: string | null | undefined): string {
  if (!room) return "";
  return isEn ? `Room ${room}` : `${room}号室`;
}

// 日付 YYYY-MM-DD を「10/21（火）」/「Tue 10/21」で表示する
export function formatDayWithWeekday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return isEn ? `${"Sun Mon Tue Wed Thu Fri Sat".split(" ")[d.getUTCDay()]} ${md}` : `${md}（${"日月火水木金土"[d.getUTCDay()]}）`;
}

// 並べるときの区切り（「タオル、歯ブラシ」/「towel, toothbrush」）
export const LIST_SEP = tr("、", ", ");

// 影響の大きい自動取得の通知の件名の先頭（現場スマホで赤く表示する）
export const ALERT_PREFIX = tr("【要注意】", "[Alert] ");

// エリアの指定がない担当（全館）
export const ALL_AREAS = tr("全館", "All areas");
