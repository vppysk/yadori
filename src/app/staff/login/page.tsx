import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listLoginMembers, MEMBER_COOKIE } from "@/server/auth";
import { tr } from "@/lib/i18n";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const memberId = String(formData.get("memberId") ?? "");
  const members = await listLoginMembers();
  if (!members.some((m) => m.id === memberId)) throw new Error(tr("メンバーが見つかりません", "Member not found"));
  (await cookies()).set(MEMBER_COOKIE, memberId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
  const next = String(formData.get("next") ?? "");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/staff/orders");
}

export default async function LoginPage({ searchParams }: PageProps<"/staff/login">) {
  const { next } = await searchParams;
  const members = await listLoginMembers();
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">{tr("スタッフとしてログイン", "Log in as staff")}</h1>
        <p className="text-sm text-ink-sub">{tr("デモ用です。メンバーを選ぶと、そのメンバーの権限で画面が表示されます。", "Demo login. Pick a member to see the app with that member's permissions.")}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {members.map((m) => (
          <li key={m.id}>
            <form action={login}>
              <input type="hidden" name="memberId" value={m.id} />
              <input type="hidden" name="next" value={typeof next === "string" ? next : ""} />
              <button
                type="submit"
                className="flex min-h-13 w-full items-center justify-between rounded-xl border border-line bg-surface px-4 text-left hover:border-primary"
              >
                <span className="text-[15px] font-bold">{m.display_name}</span>
                <span className="text-xs text-ink-sub">
                  {[...new Set([m.job_title, ...m.groups].filter(Boolean))].join(" ・ ")}
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
