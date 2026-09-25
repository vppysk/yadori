import Link from "next/link";

// 開発・デモ用の入口。予約番号は supabase/seed.sql の mock_pms.reservations
const GUEST_DEMOS = [
  { id: "R-1203", label: "ゲスト｜本日の滞在（1203号室）" },
  { id: "R-1503", label: "ゲスト｜来月の滞在（1503号室）" },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="font-mincho text-2xl font-semibold">Hotel Agent</h1>
      <ul className="flex flex-col gap-2">
        {GUEST_DEMOS.map((demo) => (
          <li key={demo.id}>
            <Link
              href={`/guest/${demo.id}`}
              className="flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[15px] hover:border-primary"
            >
              {demo.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
