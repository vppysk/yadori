import Link from "next/link";
import { tr } from "@/lib/i18n";

// 開発・デモ用の入口。予約番号は supabase/seed.sql の mock_pms.reservations、ログインは /staff/login（デモ用・パスワードなし）
const SURFACES = [
  {
    title: tr("ゲスト", "Guest"),
    note: tr("客室のQRコードから開くチャット", "Chat opened from the QR code in the room"),
    links: [
      { href: "/guest/R-1203", label: tr("本日の滞在（1203号室）", "Staying now (Room 1203)") },
      { href: "/guest/R-1503", label: tr("12月の滞在（1503号室）", "Arriving in December (Room 1503)") },
    ],
  },
  {
    title: tr("現場スマホ", "Staff phone"),
    note: tr("オーダー・AI相談・通知", "Orders, staff AI, alerts"),
    links: [{ href: "/staff/login?next=/staff/orders", label: tr("スタッフとしてログイン", "Log in as staff") }],
  },
  {
    title: tr("管理PC", "Admin console"),
    note: tr("AIの設定・オーダー管理・対応アラート", "AI settings, orders, alerts"),
    links: [
      { href: "/staff/login?next=/admin/knowledge/sources", label: tr("資料（冬季営業のお知らせを読み取る）", "Sources (read the winter notice)") },
      { href: "/staff/login?next=/admin/orders/board", label: tr("オーダー状況", "Order board") },
      { href: "/staff/login?next=/admin/handoffs", label: tr("対応アラート", "Alerts") },
    ],
  },
  {
    title: tr("経営", "Management"),
    note: tr("AIの成果・モデルの見直し", "AI results and model review"),
    links: [
      { href: "/staff/login?next=/manage", label: tr("AIの成果", "AI results") },
      { href: "/staff/login?next=/manage/models", label: tr("モデルの見直し", "Model review") },
    ],
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="font-mincho text-3xl font-semibold">Yadori</h1>
        <p className="text-sm text-ink-sub">
          {tr(
            "ホテル運営AIエージェント。NVIDIA Nemotron（Nebius Token Factory）で動くデモです。",
            "The AI teammate for hotel operations — a demo running on NVIDIA Nemotron via Nebius Token Factory.",
          )}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {SURFACES.map((s) => (
          <section key={s.title} className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-4">
            <div>
              <h2 className="text-base font-bold">{s.title}</h2>
              <p className="text-xs text-ink-sub">{s.note}</p>
            </div>
            <ul className="flex flex-col gap-1.5">
              {s.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="flex min-h-11 items-center rounded-xl border border-line px-3.5 text-[15px] hover:border-primary">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
